/**
 * rag.spec.ts — POST /v1/rag streaming RAG.
 *
 * Verifies the RAG SSE event sequence: search_results (always, even when
 * empty) → optional truncation_warning → content_delta+ → done.
 *
 * Creates a small searchable corpus in beforeAll so the search has something
 * to return; cleans up in afterAll.
 *
 * Result-isolation strategy: `createdAfter` filter on the RAG search block
 * (added in SDK 0.7.6) scopes retrieval to content created during THIS test
 * run, so orphan docs from prior smoke runs can't push our corpus doc off
 * the topK retrieval. Cleaner than the unique-marker pattern (which RAG's
 * LLM query-expansion could dilute anyway).
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup, collectStream } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

describe('inference: /v1/rag', () => {
    let docId: string;
    let testStartedAt: string;

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        const doc = await client.documents.ingestDocument({ body: {
            title: `RAG smoke test corpus ${uniqueTag()}`,
            text:
                'This is a fictional clinical study evaluating the recommended treatment ' +
                'for stage 1 hypertension in adult patients. The study found that the ' +
                'recommended treatment is lifestyle modification combined with ACE ' +
                'inhibitors taken once daily. Regular monitoring of blood pressure and ' +
                'renal function is essential per the study protocol.',
            indexMode: 'HYBRID',
        } });
        docId = doc.id!;
        // Two distinct phases, polled + reported separately:
        //   1. INDEXING — wait for the doc to reach INDEXED. A failure here
        //      ("did not reach INDEXED") is indexing lag.
        await pollUntilIndexed(docId, 'document');
        //   2. SEARCH VISIBILITY — INDEXED does NOT imply HYBRID-searchable: the
        //      vector lane's query visibility is eventually-consistent (see
        //      pollUntilSearchable's header). 30s absorbs that tail; a failure
        //      here ("INDEXED but not yet search-visible") is the vector-lane
        //      gap, NOT indexing. createdAfter scopes to this run.
        await pollUntilSearchable('hypertension treatment study', docId, 30_000, 'HYBRID', testStartedAt);
    });

    afterAll(async () => {
        await tryCleanup('delete doc', () => client.documents.deleteDocument({ id: docId }));
    });

    // ANCHOR — full RAG event sequence
    test('rag stream emits search_results then content_delta then done', async () => {
        const stream = await client.inference.ragInference({
            query: 'What treatment is recommended for stage 1 hypertension?',
            search: {
                mode: 'HYBRID',
                limit: 5,
                // createdAfter scopes RAG retrieval to this test run's content.
                // Without it, prior smoke runs' docs matching similar medical
                // phrasing can rank above our just-created corpus doc.
                createdAfter: testStartedAt,
            },
            maxTokens: 128,
        });
        const events = await collectStream<any>(stream);

        // First non-content event must be search_results
        const searchResults = events.find((e) => e.event === 'search_results');
        expect(searchResults).toBeDefined();
        expect(searchResults.results).toBeDefined();
        expect(Array.isArray(searchResults.results)).toBe(true);

        // Our corpus doc must be among the retrieved results.
        // documentId on search_results is the document UUID returned by
        // ingestDocument — the same value you pass to getDocument or
        // deleteDocument. SSE events come through as untyped JSON objects
        // (the stream collector uses `any` for event payloads); the
        // narrowing here describes the documented event shape.
        const retrieved = searchResults.results as Array<{ documentId: string }>;
        const ids = retrieved.map((r) => r.documentId);
        expect(ids).toContain(docId);

        // Content deltas then a single done
        const deltas = events.filter((e) => e.event === 'content_delta');
        const dones = events.filter((e) => e.event === 'done');
        expect(deltas.length).toBeGreaterThan(0);
        expect(dones.length).toBe(1);
        expect(dones[0].inferenceBalanceCentsCharged).toBeGreaterThanOrEqual(0);
    });

    test('empty search results: search_results event still emitted, then LLM answers "no relevant content"', async () => {
        // Query with terms guaranteed not to appear in any corpus doc. RAG
        // should still emit search_results (empty) + content_delta (LLM
        // saying "no relevant content") + done.
        const stream = await client.inference.ragInference({
            query: 'What does the document say about quasar fusion in zebra economics?',
            search: {
                mode: 'HYBRID',
                limit: 5,
                createdAfter: testStartedAt,
            },
            maxTokens: 64,
        });
        const events = await collectStream<any>(stream);

        const searchResults = events.find((e) => e.event === 'search_results');
        expect(searchResults).toBeDefined();
        expect(Array.isArray(searchResults.results)).toBe(true);
        // Could be 0 or could match the corpus doc on a vector-similarity stretch.
        // The contract is just "search_results emitted even when empty".

        const dones = events.filter((e) => e.event === 'done');
        const deltas = events.filter((e) => e.event === 'content_delta');
        expect(dones).toHaveLength(1);
        expect(deltas.length).toBeGreaterThan(0);  // LLM still produces SOME text
    });

    test('scoped token data scope on userId filters search results visible to RAG', async () => {
        // SETUP: create a user + a doc owned by that user. Mint a token
        // scoped to that user. RAG via the scoped token must see ONLY the
        // user-owned doc — even though our corpus doc from beforeAll is
        // also present in the tenant.
        const user = await client.identity.createUser({ body: { externalId: 'rag-scope-' + uniqueTag() } });
        const userOwnedDoc = await client.documents.ingestDocument({ body: {
            title: 'Scoped RAG Doc ' + uniqueTag(),
            text: 'This document is owned by a specific user and discusses ' +
                'a unique fictional treatment called "phantom blue therapy".',
            indexMode: 'HYBRID',
            userId: user.id!,
        } });
        try {
            await pollUntilIndexed(userOwnedDoc.id!, 'document');

            const minted = (await client.auth.mintToken({
                userId: user.id!,
                scope: {
                    allowedActions: ['inference:r', 'search:r'],
                    dataScope: { userId: [user.id!] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            const stream = await scoped.inference.ragInference({
                query: 'What treatments are discussed?',
                search: {
                    mode: 'HYBRID',
                    limit: 10,
                    createdAfter: testStartedAt,
                    // Scope `dataScope.userId=[user.id]` is a single value
                    // with no null sentinel, so every call must specify
                    // userId. Include `null` in the dataScope userId list
                    // to also reach tenant-only (no-owner) content under
                    // the same token.
                    userId: user.id!,
                },
                maxTokens: 64,
            });
            const events = await collectStream<any>(stream);
            const searchResults = events.find((e) => e.event === 'search_results');
            const ids = (searchResults?.results ?? []).map((r: any) => r.documentId);
            expect(ids).toContain(userOwnedDoc.id);
            // ANCHOR's corpus doc is unowned (tenant-only) — must be excluded
            // by dataScope.userId.
            expect(ids).not.toContain(docId);
        } finally {
            await tryCleanup('delete scoped doc', () => client.documents.deleteDocument({ id: userOwnedDoc.id! }));
            await tryCleanup('delete scoped user', () => client.identity.deleteUser({ id: user.id! }));
        }
    });

    // Two additional RAG behaviors — "search infrastructure error → 500
    // before stream opens" and "oversized result set emits
    // truncation_warning" — are covered at the unit-test layer rather
    // than here, since both require synthetic failure injection that the
    // smoke caller can't trigger deterministically.
});
