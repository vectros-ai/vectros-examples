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
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
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
            fetch: rateLimitAwareFetch, maxRetries: 0, // shared per-tenant burst limit — see src/rateLimitFetch.ts
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
        await expect(scoped.records.createRecord({ body: {
            typeName: 'smoke_unauthorized_' + uniqueTag(),
            schemaId: 'irrelevant-blocked-by-scope',
            payload: {},
        } })).rejects.toMatchObject({ statusCode: 403 });
    });

    test('scoped token with dataScope.userId restricts list/search results to owned content', async () => {
        // SETUP: create a schema + user + a record owned by that user, plus
        // a control record owned by NO user. The dataScope-restricted token
        // should see only the user-owned record.
        const recordType = `smoke_dscope_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'DataScope Test Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'name', fieldType: 'string', required: true, searchable: true },
            ],
        } });
        const user = await client.identity.createUser({ body: { externalId: 'dscope-' + uniqueTag() } });

        const uniquePhrase = 'DATASCOPE_PROBE_' + uniqueTag().replace(/-/g, '_');
        const recordForUser = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId: schema.id!,
            payload: { name: uniquePhrase + ' for user' },
            userId: user.id!,
        } });
        const recordTenantOnly = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId: schema.id!,
            payload: { name: uniquePhrase + ' tenant only' },
            // no userId — tenant-owned (ownership field is null)
        } });
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

    // -------------------------------------------------------------------------
    // 0.38.0 — placement matchers in data_scope. The two tests below are
    // illustrative, not exhaustive: they show the SHAPE a customer authoring
    // a data_scope needs to know, not a proof of every matcher combination.
    // -------------------------------------------------------------------------

    test('dataScope placement matcher ${{ under.self.scope.<namespace> }} — work with entities under your own without enumerating them', async () => {
        // identity supplies the credential's OWN org value; the clause below
        // names the CLIENT dimension as "whatever is one level under my own
        // org" — so this token can read any client entity under `org`,
        // present or future, without ever naming that client's id.
        const recordType = `smoke_dscope_under_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'DataScope Placement Matcher Test Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'name', fieldType: 'string', required: true, searchable: true }],
        } });

        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'under-org-' + uniqueTag(), name: 'Under-Matcher Org',
        } });
        // childClient's own scopes name org as its parent — that is what
        // "immediate parent is your own" resolves against.
        const childClient = await client.identity.createEntity({ namespace: 'client', body: {
            externalId: 'under-child-' + uniqueTag(), name: 'Child Client', scopes: [`org:${org.id}`],
        } });
        const otherOrg = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'under-other-org-' + uniqueTag(), name: 'Other Org',
        } });
        const unrelatedClient = await client.identity.createEntity({ namespace: 'client', body: {
            externalId: 'under-unrelated-' + uniqueTag(), name: 'Unrelated Client', scopes: [`org:${otherOrg.id}`],
        } });

        const recordForChild = await client.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { name: 'child record' },
            scopes: [`client:${childClient.id}`],
        } });
        const recordForUnrelated = await client.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { name: 'unrelated record' },
            scopes: [`client:${unrelatedClient.id}`],
        } });
        await pollUntilIndexed(recordForChild.id!, 'record');
        await pollUntilIndexed(recordForUnrelated.id!, 'record');

        try {
            const minted = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:r'],
                    identity: { 'scope:org': org.id! },
                    dataScope: { 'scope:client': ['${{ under.self.scope.org }}'] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            const childResult = await scoped.records.listRecords({
                type: recordType, scope: `client:${childClient.id}`,
            });
            expect((childResult.data ?? []).map((r) => r.id)).toContain(recordForChild.id);

            // unrelatedClient's parent is otherOrg, not org — the matcher is
            // one level, not a full ancestor walk, and otherOrg isn't `org` —
            // so an explicit ask for it is refused outright (the upfront
            // list-params gate), not merely filtered to an empty page.
            await expect(scoped.records.listRecords({
                type: recordType, scope: `client:${unrelatedClient.id}`,
            })).rejects.toMatchObject({ statusCode: 403 });
        } finally {
            await tryCleanup('record (child)', () => client.records.deleteRecord({ id: recordForChild.id! }));
            await tryCleanup('record (unrelated)', () => client.records.deleteRecord({ id: recordForUnrelated.id! }));
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schema.id! }));
            await tryCleanup('child client entity', () =>
                client.identity.deleteEntity({ namespace: 'client', id: childClient.id! }));
            await tryCleanup('unrelated client entity', () =>
                client.identity.deleteEntity({ namespace: 'client', id: unrelatedClient.id! }));
            await tryCleanup('org entity', () => client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
            await tryCleanup('other org entity', () => client.identity.deleteEntity({ namespace: 'org', id: otherOrg.id! }));
        }
    });

    test('dataScope "*" wildcard — one clause covers every ownership dimension without enumerating them', async () => {
        // "*" states a rule for every dimension a clause does not name
        // explicitly. This clause names none, so it applies to all of
        // them — one entry grants read across userId AND every scope
        // namespace at once, instead of listing "userId", "scope:org",
        // "scope:client", ... one by one.
        const recordType = `smoke_dscope_wildcard_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'DataScope Wildcard Test Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'name', fieldType: 'string', required: true, searchable: true }],
        } });
        const user = await client.identity.createUser({ body: { externalId: 'wc-' + uniqueTag() } });
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'wc-org-' + uniqueTag(), name: 'Wildcard Org',
        } });
        const otherOrg = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'wc-other-org-' + uniqueTag(), name: 'Wildcard Other Org',
        } });

        const recordForUser = await client.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { name: 'owned by user' }, userId: user.id!,
        } });
        const recordForOrg = await client.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { name: 'scoped to org' }, scopes: [`org:${org.id}`],
        } });
        const recordForOtherOrg = await client.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { name: 'scoped to another org' },
            scopes: [`org:${otherOrg.id}`],
        } });
        await pollUntilIndexed(recordForUser.id!, 'record');
        await pollUntilIndexed(recordForOrg.id!, 'record');
        await pollUntilIndexed(recordForOtherOrg.id!, 'record');

        try {
            const minted = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:r'],
                    // The SDK types a dataScope array as string[]; null is a
                    // documented sentinel value at the wire level (matches
                    // the established idiom in null-sentinel-search.spec.ts).
                    dataScope: { '*': ['${{ any }}', null as unknown as string] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            const byUser = await scoped.records.listRecords({ type: recordType, userId: user.id! });
            expect((byUser.data ?? []).map((r) => r.id)).toContain(recordForUser.id);

            const byOrg = await scoped.records.listRecords({ type: recordType, scope: `org:${org.id}` });
            expect((byOrg.data ?? []).map((r) => r.id)).toContain(recordForOrg.id);

            // The boundary a customer copying "*" needs to know: a NAMED
            // dimension always takes precedence over it, even where "*" alone
            // would have admitted the row. Combine the wildcard with an
            // explicit `scope:org` naming only THIS org — the wildcard no
            // longer covers `org` at all once it's named; every other org is
            // refused outright rather than falling back to the wildcard.
            const mintedNarrowed = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:r'],
                    dataScope: {
                        '*': ['${{ any }}', null as unknown as string],
                        'scope:org': [org.id!],
                    },
                },
            })) as MintedToken;
            const scopedNarrowed = getScopedClient(mintedNarrowed.token);

            // The named org is still admitted...
            const narrowedByOrg = await scopedNarrowed.records.listRecords({
                type: recordType, scope: `org:${org.id}`,
            });
            expect((narrowedByOrg.data ?? []).map((r) => r.id)).toContain(recordForOrg.id);
            // ...but the OTHER org is refused outright, even though "*" alone
            // would have admitted it — naming `org` took the wildcard's place
            // for that one dimension, rather than adding to it.
            await expect(scopedNarrowed.records.listRecords({
                type: recordType, scope: `org:${otherOrg.id}`,
            })).rejects.toMatchObject({ statusCode: 403 });
        } finally {
            await tryCleanup('record (user)', () => client.records.deleteRecord({ id: recordForUser.id! }));
            await tryCleanup('record (org)', () => client.records.deleteRecord({ id: recordForOrg.id! }));
            await tryCleanup('record (other org)', () => client.records.deleteRecord({ id: recordForOtherOrg.id! }));
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schema.id! }));
            await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            await tryCleanup('other org entity', () => client.identity.deleteEntity({ namespace: 'org', id: otherOrg.id! }));
            await tryCleanup('org entity', () => client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
        }
    });

    // Any ${{ … }}-shaped dataScope value other than the exact recognised spellings
    // (${{ self.* }}, ${{ any }}, ${{ under.self.userId }}, ${{ under.self.scope.<ns> }}, and — since
    // 0.40.0 — ${{ member.scope.<ns> }} / ${{ member.scope.<ns>:<level> }}, see namespaces.spec.ts) must
    // be rejected at mint time — guarding against a near-miss spelling silently storing as an inert,
    // always-false literal.
    test.each([
        ['wrong case', '${{ Any }}'],
        ['unrecognized bare word', '${{ nonsense }}'],
        ['unrecognized under. sub-form', '${{ under.self.foo }}'],
        ['near-miss on the shipped self form', '${{ self }}'],
    ])('a malformed placement-matcher spelling (%s) is rejected at mint time', async (_label, value) => {
        await expect(client.auth.mintToken({
            scope: { allowedActions: ['records:r'], dataScope: { 'scope:org': [value] } },
        })).rejects.toMatchObject({ statusCode: 400 });
    });

    // 0.40.0: POST /v1/auth/token's contextId-not-found 404 previously hand-assembled its body —
    // {"message": ...} only, missing requestId, and no Content-Type header. It now returns the
    // SAME envelope as every other error on the API. Raw fetch (not the SDK) so the wire body and
    // headers are inspectable directly, same pattern as error-contract.spec.ts.
    test("mintToken with a nonexistent contextId → 404 with the standard error envelope (requestId, Content-Type)", async () => {
        const baseUrl = process.env.VECTROS_API_BASE_URL!.replace(/\/+$/, '');
        const resp = await fetch(`${baseUrl}/v1/auth/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.VECTROS_API_KEY}`,
            },
            body: JSON.stringify({
                scope: { allowedActions: ['records:r'] },
                // contextId is capped at 31 chars — 'no-such-context-' + uniqueTag() (25 chars)
                // is 41, over the limit, and would 400 on FORMAT before ever reaching the
                // not-found check this test targets.
                contextId: ('nosuch-' + uniqueTag()).slice(0, 31),
            }),
        });
        expect(resp.status).toBe(404);
        expect(resp.headers.get('content-type')).toMatch(/application\/json/);
        const body = JSON.parse(await resp.text()) as { message?: string; requestId?: string };
        expect(typeof body.message).toBe('string');
        expect(typeof body.requestId).toBe('string');
        expect(body.requestId).toBeTruthy();
    });
});
