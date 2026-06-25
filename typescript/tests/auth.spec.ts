/**
 * auth.spec.ts — API key auth, health check, and scoped token mint/enforce cycle.
 *
 * The ping test is the single most important smoke check: if it fails, the
 * API key is invalid or the API is unreachable.
 *
 * Scope grammar — strings of the form "resource:opLetters[:qualifier]":
 *
 *   resource     = "records", "schemas", "documents", "folders", "search",
 *                  "profiles", "billing", "logs", "inference", etc.
 *   opLetters    = any combo of 'c' 'r' 'u' 'd' (e.g. "r", "cr", "crud")
 *   qualifier    = optional record-type narrowing (e.g. "patient")
 *   "*"          = single-entry wildcard that grants everything
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, tryCleanup } from '../src/helpers';

// mintToken returns Record<string, unknown> from the SDK (the underlying schema
// doesn't pin the response shape tightly). Narrow to the fields we actually use.
interface MintedToken {
    token: string;
    expiresAt: number;
}

describe('auth', () => {
    // ANCHOR — most important test in the suite
    test('ping returns 200 with valid API key', async () => {
        // ping returns the authenticated principal's identity (status +
        // tenantId + principalType + ...). The shape-level assertions live in
        // identity.spec.ts; here we only care
        // that the call resolves with a defined body — i.e. the API key is
        // valid and the API is reachable.
        await expect(client.auth.ping()).resolves.toBeDefined();
    });

    test('ping returns 403 with invalid key', async () => {
        // Invalid keys surface as 403 (not 401) — the request is denied
        // before any handler runs.
        const badClient = new VectrosClient({
            token: 'sk_live_invalid_for_smoke_test',
            environment: process.env.VECTROS_API_BASE_URL!,
        });
        await expect(badClient.auth.ping()).rejects.toMatchObject({
            statusCode: 403,
        });
    });

    test('mint scoped token returns token + expiresAt', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        expect(minted.token).toMatch(/^st_/);
        expect(minted.expiresAt).toBeGreaterThan(Date.now() / 1000);
    });

    test('scoped token with records:r allows list but blocks create (action-letter enforcement)', async () => {
        // Mint a read-only records token. Verifies the action-letter half of
        // the scope grammar: 'r' allows GET/list, blocks POST/PUT/DELETE.
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);

        // listRecords is a read — allowed.
        await expect(scoped.records.listRecords({ type: 'any' })).resolves.toBeDefined();

        // createRecord is a write — must be rejected with a uniform 403.
        // The error message is generic on purpose; the API does not reveal
        // which specific scope check failed to avoid leaking enforcement
        // shape to probing callers.
        await expect(scoped.records.createRecord({
            typeName: 'smoke_unauthorized_' + uniqueTag(),
            schemaId: 'irrelevant-blocked-by-scope',
            payload: {},
        })).rejects.toMatchObject({ statusCode: 403 });
    });

    test('scoped token with dataScope.userId restricts list/search results to owned content', async () => {
        // SETUP: create a schema + user + a record owned by that user, plus
        // a control record owned by NO user. The dataScope-restricted token
        // should see only the user-owned record.
        const recordType = `smoke_dscope_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({
            typeName: recordType,
            displayName: 'DataScope Test Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'name', fieldType: 'string', required: true, searchable: true },
            ],
        });
        const user = await client.identity.createUser({ externalId: 'dscope-' + uniqueTag() });

        const uniquePhrase = 'DATASCOPE_PROBE_' + uniqueTag().replace(/-/g, '_');
        const recordForUser = await client.records.createRecord({
            typeName: recordType,
            schemaId: schema.id!,
            payload: { name: uniquePhrase + ' for user' },
            userId: user.id!,
        });
        const recordTenantOnly = await client.records.createRecord({
            typeName: recordType,
            schemaId: schema.id!,
            payload: { name: uniquePhrase + ' tenant only' },
            // no userId — tenant-owned (ownership field is null)
        });
        await pollUntilIndexed(recordForUser.id!, 'record');
        await pollUntilIndexed(recordTenantOnly.id!, 'record');

        try {
            // Mint a token scoped to this user only.
            const minted = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:r', 'search:r'],
                    dataScope: { userId: [user.id!] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            // listRecords with explicit userId filter — returns ONLY the
            // user-owned record. The tenant-only record is filtered out.
            const list = await scoped.records.listRecords({ type: recordType, userId: user.id! });
            const listedIds = (list.data ?? []).map((r) => r.id);
            expect(listedIds).toContain(recordForUser.id);
            expect(listedIds).not.toContain(recordTenantOnly.id);

            // Search — same dataScope contract. userId is REQUIRED in the
            // request body because the scope's dataScope.userId=[user.id] has
            // no null sentinel; strict-scope mode requires the call to carry
            // the field explicitly. To also access tenant-level (no-owner)
            // content under the same token, include `null` in the dataScope
            // userId list — opt-in widening, never implicit.
            const results = await scoped.search.content({
                query: uniquePhrase,
                mode: 'TEXT',
                limit: 100,
                userId: user.id!,
            });
            const hitIds = (results.results ?? []).map((r) => r.documentId);
            expect(hitIds).toContain(recordForUser.id);
            expect(hitIds).not.toContain(recordTenantOnly.id);
        } finally {
            await tryCleanup('record (user)', () => client.records.deleteRecord({ id: recordForUser.id! }));
            await tryCleanup('record (tenant)', () => client.records.deleteRecord({ id: recordTenantOnly.id! }));
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schema.id! }));
            await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
        }
    });
});
