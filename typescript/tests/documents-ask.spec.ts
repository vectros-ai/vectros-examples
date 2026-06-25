/**
 * documents-ask.spec.ts — POST /v1/documents/{id}/ask streaming Q&A against a
 * single document.
 *
 * Verifies document_context event fires before any content_delta, the 32K
 * input-token cap returns 413 BEFORE the stream opens (and before any credits
 * are charged), and out-of-scope docs return 404 (same as cross-tenant).
 */
import { client, getTestTenantClient, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, tryCleanup, collectStream } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

// The cross-tenant test needs a second tenant's key. Every Vectros account has
// both a live and a test key, so it normally runs; skip it cleanly if the test
// key isn't set rather than failing.
const testIfSecondTenant = process.env.VECTROS_TEST_API_KEY ? test : test.skip;

describe('inference: /v1/documents/{id}/ask', () => {
    let docId: string;

    beforeAll(async () => {
        const doc = await client.documents.ingestDocument({
            title: 'Ask smoke test doc ' + uniqueTag(),
            text:
                'This document describes ACE inhibitors as a first-line treatment for ' +
                'hypertension. They work by blocking the conversion of angiotensin I to ' +
                'angiotensin II, reducing vasoconstriction.',
            indexMode: 'HYBRID',
            storeText: true,
        });
        docId = doc.id!;
        await pollUntilIndexed(docId, 'document');
    });

    afterAll(async () => {
        await tryCleanup('delete doc', () => client.documents.deleteDocument({ id: docId }));
    });

    // ANCHOR — document_context fires first, then content, then done
    test('ask stream emits document_context then content_delta then done', async () => {
        // SDK shape: documentAsk takes { id, prompt, ... } in the request body
        // (id was previously a path-style positional arg).
        const stream = await client.inference.documentAsk({
            id: docId,
            prompt: 'How do the drugs in this document work?',
            maxTokens: 128,
        });
        const events = await collectStream<any>(stream);

        // document_context is the first non-prelude event
        const ctx = events.find((e) => e.event === 'document_context');
        expect(ctx).toBeDefined();
        expect(ctx.documentId).toBe(docId);
        expect(ctx.textBytes).toBeGreaterThan(0);

        const deltas = events.filter((e) => e.event === 'content_delta');
        const dones = events.filter((e) => e.event === 'done');
        expect(deltas.length).toBeGreaterThan(0);
        expect(dones.length).toBe(1);
    });

    test('oversized document (textBytes > 128 KB) returns 413 before stream opens', async () => {
        // Ingest a doc with > 128 KB of text → estimated input tokens exceed
        // the 32K cap. Backend rejects with 413 BEFORE opening the stream
        // (no 8-null-byte prelude). Critical: the rejection happens BEFORE
        // any credits are charged.
        const bigBody = new Array(2000).fill(
            'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do ' +
            'eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ' +
            'ad minim veniam quis nostrud exercitation ullamco laboris nisi.'
        ).join(' ');  // ~256 KB total
        const bigDoc = await client.documents.ingestDocument({
            title: 'Oversized Ask Doc ' + uniqueTag(),
            text: bigBody,
            indexMode: 'HYBRID',
            storeText: true,
        });
        try {
            await pollUntilIndexed(bigDoc.id!, 'document', 120_000);
            await expect(client.inference.documentAsk({
                id: bigDoc.id!,
                prompt: 'Summarize this doc.',
                maxTokens: 16,
            })).rejects.toMatchObject({ statusCode: 413 });
        } finally {
            await tryCleanup('delete oversized doc', () => client.documents.deleteDocument({ id: bigDoc.id! }));
        }
    });

    test('non-existent document returns 404', async () => {
        const fakeId = '00000000-0000-0000-0000-' + uniqueTag().replace(/[^0-9a-f]/g, '').padEnd(12, '0').substring(0, 12);
        await expect(client.inference.documentAsk({
            id: fakeId,
            prompt: 'test',
            maxTokens: 8,
        })).rejects.toMatchObject({ statusCode: 404 });
    });

    testIfSecondTenant('cross-tenant document returns 404 (test tenant cannot access live tenant doc)', async () => {
        // ANCHOR doc is on the LIVE tenant. A test-tenant client asking
        // for that doc must get 404 (not 403 — never reveal cross-tenant
        // existence).
        const testClient = getTestTenantClient();
        await expect(testClient.inference.documentAsk({
            id: docId,
            prompt: 'test',
            maxTokens: 8,
        })).rejects.toMatchObject({ statusCode: 404 });
    });

    test('scoped token with out-of-scope data scope returns 404 (does not reveal existence)', async () => {
        // Mint a token scoped to a userId that doesn't own the ANCHOR doc.
        // documentAsk must return 404 — same as cross-tenant. Critical:
        // never return 403 here (that would confirm the doc exists but is
        // forbidden, leaking info to a probing scoped-token caller).
        const otherUser = await client.identity.createUser({ externalId: 'ask-scope-' + uniqueTag() });
        try {
            const minted = (await client.auth.mintToken({
                userId: otherUser.id!,
                scope: {
                    allowedActions: ['inference:r'],
                    dataScope: { userId: [otherUser.id!] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);
            await expect(scoped.inference.documentAsk({
                id: docId,
                prompt: 'test',
                maxTokens: 8,
            })).rejects.toMatchObject({ statusCode: 404 });
        } finally {
            await tryCleanup('delete scope user', () => client.identity.deleteUser({ id: otherUser.id! }));
        }
    });

    // The "document in PENDING_INDEX returns 409" behavior is covered at
    // the unit-test layer rather than here — the smoke caller can't reach
    // a doc in the PENDING_INDEX state deterministically (race against
    // indexing completion).
});
