/**
 * identity.spec.ts — User CRUD plus the generic identity-entity surface
 * (`/v1/entities/{namespace}`): namespaced entity CRUD with externalId
 * idempotency, parent ownership edges via `scopes`, and `namespace:value`
 * scope values as the primary multi-tenancy primitive for scoped tokens.
 * Also covers the /v1/ping identity-binding contract.
 *
 * `org` and `client` are built-in entity-backed namespaces, so no namespace
 * registration is needed to use them; a custom namespace (e.g. `team`) is
 * registered first via `POST /v1/namespaces`.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, tryCleanup } from '../src/helpers';

interface MintedToken {
    token: string;
    expiresAt: number;
}

/**
 * The /v1/ping response shape and its field-presence rules. Declared locally
 * so the test asserts against the contract even when the installed
 * @vectros-ai/sdk hasn't been regenerated yet (SDK ping() may return `void`
 * until then; cast through `unknown` to land in this shape).
 */
interface PingIdentity {
    status: 'ok';
    tenantId: string;
    environment: 'staging' | 'production';
    principalType: 'root_key' | 'scoped_key' | 'token';
    principalKeyId: string;
    principalLabel?: string;
    allowedActions?: string[];
    dataScope?: { userId?: string; scopes?: string[] };
    tokenExpiresAt?: number;
}

describe('identity', () => {
    // ----- /v1/ping identity-binding contract -----
    //
    // Required fields are asserted unconditionally; conditional fields are
    // asserted per-principalType per the locked spec:
    //   root_key   → allowedActions / dataScope / tokenExpiresAt all absent
    //   scoped_key → allowedActions present + non-empty; dataScope present
    //                iff principal is bound to a userId or scope value
    //   token      → tokenExpiresAt present and > now
    test('ping returns root_key identity for a sk_* API key', async () => {
        const body = (await client.auth.ping()) as unknown as PingIdentity;

        // Required fields — always present.
        expect(body.status).toBe('ok');
        expect(typeof body.tenantId).toBe('string');
        expect(body.tenantId.length).toBeGreaterThan(0);
        expect(['staging', 'production']).toContain(body.environment);
        expect(body.principalType).toBe('root_key');
        expect(typeof body.principalKeyId).toBe('string');
        expect(body.principalKeyId.length).toBeGreaterThan(0);

        // root_key conditional fields — ALL absent per design rule.
        expect(body.allowedActions).toBeUndefined();
        expect(body.dataScope).toBeUndefined();
        expect(body.tokenExpiresAt).toBeUndefined();

        // principalLabel is per-key opt-in. If your API key was minted without
        // a label, it's omitted — but if a label IS set, the plumbing must
        // return it as a non-empty string. This assertion tightens to a
        // presence check automatically once a label is set on the key.
        if (body.principalLabel !== undefined) {
            expect(typeof body.principalLabel).toBe('string');
            expect(body.principalLabel.length).toBeGreaterThan(0);
        }
    });

    test('ping returns token identity (with tokenExpiresAt) for a st_* scoped token', async () => {
        // Mint a short-lived st_* token from the root key, then ping with it.
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);

        const body = (await scoped.auth.ping()) as unknown as PingIdentity;

        // Required fields.
        expect(body.status).toBe('ok');
        expect(typeof body.tenantId).toBe('string');
        expect(['staging', 'production']).toContain(body.environment);
        expect(body.principalType).toBe('token');
        expect(typeof body.principalKeyId).toBe('string');

        // token conditional fields per design:
        //   - tokenExpiresAt present and > now
        //   - allowedActions + dataScope absent (tokens carry scope in JWT
        //     claims; intentionally out of scope for the ping response)
        //   - principalLabel absent — st_* tokens have no backing key row,
        //     so the label channel is always omitted.
        expect(typeof body.tokenExpiresAt).toBe('number');
        expect(body.tokenExpiresAt!).toBeGreaterThan(Math.floor(Date.now() / 1000));
        // tokenExpiresAt should roughly match the minted token's expiresAt
        // (the JWT exp claim is the source of both); allow a few seconds of
        // clock drift to keep this from flaking.
        expect(Math.abs(body.tokenExpiresAt! - minted.expiresAt)).toBeLessThan(5);
        expect(body.allowedActions).toBeUndefined();
        expect(body.dataScope).toBeUndefined();
        expect(body.principalLabel).toBeUndefined();
    });

    test('user CRUD + externalId idempotency', async () => {
        const externalId = uniqueTag();
        const user = await client.identity.createUser({ body: {
            externalId,
            email: `${externalId}@test.com`,
            // Users carry a free-form `payload`, typed Record<string, unknown>.
            // No schemaId here, so the payload is unvalidated free-form — we
            // just round-trip it.
            payload: { profile: { role: 'clinician' } },
        } });
        expect(user.externalId).toBe(externalId);
        expect(user.status).toBe('ACTIVE');

        try {
            // Idempotency: second create with same externalId returns same record
            const user2 = await client.identity.createUser({ body: {
                externalId,
                email: 'different@test.com',
            } });
            expect(user2.id).toBe(user.id);

            const loaded = await client.identity.getUser({ id: user.id! });
            expect(loaded.email).toBe(`${externalId}@test.com`);

            // listUsers returns the { data, nextCursor } envelope.
            const list = await client.identity.listUsers({ externalId });
            expect(list.data ?? []).toHaveLength(1);

            await client.identity.updateUser({
                id: user.id!,
                body: { externalId, payload: { profile: { role: 'admin' } } },
            });
            const updated = await client.identity.getUser({ id: user.id! });
            // payload is typed Record<string, unknown> — narrow at the boundary
            // so the nested-shape assertion compiles. The wire format preserves
            // the shape we set on updateUser above.
            const meta = updated.payload as { profile?: { role?: string } } | undefined;
            expect(meta?.profile?.role).toBe('admin');
        } finally {
            await tryCleanup('delete user', () => client.identity.deleteUser({ id: user.id! }));
        }
    });

    test('org entity CRUD + externalId idempotency', async () => {
        const externalId = uniqueTag();
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId,
            name: 'Smoke Clinic',
            payload: { region: 'northeast' },
        } });
        expect(org.namespace).toBe('org');
        expect(org.externalId).toBe(externalId);
        expect(org.status).toBe('ACTIVE');
        // An entity is always in its own scope — the effective scopes lead with
        // the virtual self-reference `<namespace>:<id>`.
        expect(org.scopes ?? []).toContain(`org:${org.id}`);

        try {
            // Idempotency — same externalId returns same record (different name ignored)
            const org2 = await client.identity.createEntity({ namespace: 'org', body: {
                externalId,
                name: 'Different Name (idempotent return drops this)',
            } });
            expect(org2.id).toBe(org.id);
            expect(org2.name).toBe('Smoke Clinic');

            const loaded = await client.identity.getEntity({ namespace: 'org', id: org.id! });
            expect(loaded.name).toBe('Smoke Clinic');

            const list = await client.identity.listEntities({ namespace: 'org', externalId });
            expect(list.data ?? []).toHaveLength(1);

            await client.identity.updateEntity({
                namespace: 'org',
                id: org.id!,
                body: { externalId, name: 'Updated Clinic' },
            });
            const updated = await client.identity.getEntity({ namespace: 'org', id: org.id! });
            expect(updated.name).toBe('Updated Clinic');
        } finally {
            await tryCleanup('delete org', () =>
                client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
        }
    });

    test('client entity CRUD + org parent edge + externalId idempotency', async () => {
        // Need an org first to make the parent edge to.
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'org-' + uniqueTag(),
            name: 'Parent Org for Client Test',
        } });
        const externalId = uniqueTag();
        // The org parent is a `scopes` entry (`<namespace>:<value>`). A parent
        // must live in a DIFFERENT namespace from the entity's own.
        const clientRecord = await client.identity.createEntity({ namespace: 'client', body: {
            externalId,
            name: 'Jane Doe',
            scopes: [`org:${org.id}`],
        } });
        expect(clientRecord.namespace).toBe('client');
        // Effective scopes = the entity's own self-reference + its parent edges.
        expect(clientRecord.scopes ?? []).toContain(`org:${org.id}`);
        expect(clientRecord.status).toBe('ACTIVE');

        try {
            // Idempotency on the client entity.
            const client2 = await client.identity.createEntity({ namespace: 'client', body: {
                externalId,
                name: 'Different (idempotent return)',
            } });
            expect(client2.id).toBe(clientRecord.id);

            const loaded = await client.identity.getEntity({ namespace: 'client', id: clientRecord.id! });
            expect(loaded.scopes ?? []).toContain(`org:${org.id}`);

            // List client entities whose parent is our org — should contain ours.
            const listByOrg = await client.identity.listEntities({
                namespace: 'client',
                scope: `org:${org.id}`,
            });
            expect((listByOrg.data ?? []).map((c) => c.id)).toContain(clientRecord.id);

            // List client entities filtered by externalId — exactly one result.
            const listByExt = await client.identity.listEntities({ namespace: 'client', externalId });
            expect(listByExt.data ?? []).toHaveLength(1);

            // On update, omit `scopes` to leave the parent edges unchanged.
            await client.identity.updateEntity({
                namespace: 'client',
                id: clientRecord.id!,
                body: { externalId, name: 'Jane Doe (renamed)' },
            });
            const updated = await client.identity.getEntity({ namespace: 'client', id: clientRecord.id! });
            expect(updated.name).toBe('Jane Doe (renamed)');
            expect(updated.scopes ?? []).toContain(`org:${org.id}`);
        } finally {
            await tryCleanup('client', () =>
                client.identity.deleteEntity({ namespace: 'client', id: clientRecord.id! }));
            await tryCleanup('org', () =>
                client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
        }
    });

    test('client-scoped token restricts record list/search to client-owned records', async () => {
        // SETUP: org + client entities + schema + two records, one owned by the
        // client, one tenant-only. A token bound to scope `client:<id>` should
        // see only the client-owned record.
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'org-' + uniqueTag(),
            name: 'Scope Test Org',
        } });
        const clientRecord = await client.identity.createEntity({ namespace: 'client', body: {
            externalId: 'cli-' + uniqueTag(),
            name: 'Scope Test Client',
            scopes: [`org:${org.id}`],
        } });
        const recordType = `smoke_cliscope_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Client Scope Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', required: true, searchable: true }],
        } });
        const uniquePhrase = 'CLISCOPE_PROBE_' + uniqueTag().replace(/-/g, '_');
        // Ownership is authored through the record's `scopes` array as
        // `<namespace>:<value>` entries — here the client entity and its org.
        const recordForClient = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId: schema.id!,
            payload: { note: uniquePhrase + ' client-owned' },
            scopes: [`client:${clientRecord.id}`, `org:${org.id}`],
        } });
        const recordTenantOnly = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId: schema.id!,
            payload: { note: uniquePhrase + ' tenant-only' },
        } });
        await pollUntilIndexed(recordForClient.id!, 'record');
        await pollUntilIndexed(recordTenantOnly.id!, 'record');

        try {
            // dataScope is keyed by `scope:<namespace>`; the value list holds the
            // bound scope values for that namespace.
            const minted = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:r', 'search:r'],
                    dataScope: { 'scope:client': [clientRecord.id!] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            // listRecords narrowed by `scope` — only the client-owned record.
            const list = await scoped.records.listRecords({
                type: recordType,
                scope: `client:${clientRecord.id}`,
            });
            const listedIds = (list.data ?? []).map((r) => r.id);
            expect(listedIds).toContain(recordForClient.id);
            expect(listedIds).not.toContain(recordTenantOnly.id);

            // Search — same contract. The `scope` MUST appear in the request
            // because the token's dataScope `scope:client` is a single value
            // with no null sentinel; strict-scope mode requires the field.
            // Omitting it triggers a 403. To also reach tenant-level
            // (no-client) records under the same token, include `null` in the
            // dataScope value list — opt-in widening, never implicit.
            const results = await scoped.search.content({
                query: uniquePhrase,
                mode: 'TEXT',
                limit: 100,
                scope: `client:${clientRecord.id}`,
            });
            const hitIds = (results.results ?? []).map((r) => r.documentId);
            expect(hitIds).toContain(recordForClient.id);
            expect(hitIds).not.toContain(recordTenantOnly.id);
        } finally {
            await tryCleanup('record (client)', () =>
                client.records.deleteRecord({ id: recordForClient.id! }));
            await tryCleanup('record (tenant)', () =>
                client.records.deleteRecord({ id: recordTenantOnly.id! }));
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schema.id! }));
            await tryCleanup('client', () =>
                client.identity.deleteEntity({ namespace: 'client', id: clientRecord.id! }));
            await tryCleanup('org', () =>
                client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
        }
    });

    // org mirror of the client-scoped token test above — same shape,
    // different ownership dimension. A reviewer can diff the two tests
    // to confirm the only delta is which scope value is being enforced.
    test('org-scoped token restricts record list/search to org-owned records', async () => {
        // SETUP: org entity + schema + two records, one tagged with the org
        // scope, one tenant-only. A token bound to scope `org:<id>` should see
        // only the org-tagged record. Mirrors the client-scope test's shape
        // exactly so a future reviewer can diff them and confirm the only delta
        // is the ownership dimension under test.
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'org-' + uniqueTag(),
            name: 'OrgScope Test Org',
        } });
        const recordType = `smoke_orgscope_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Org Scope Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', required: true, searchable: true }],
        } });
        const uniquePhrase = 'ORGSCOPE_PROBE_' + uniqueTag().replace(/-/g, '_');
        const recordForOrg = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId: schema.id!,
            payload: { note: uniquePhrase + ' org-tagged' },
            scopes: [`org:${org.id}`],
        } });
        const recordTenantOnly = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId: schema.id!,
            payload: { note: uniquePhrase + ' tenant-only' },
        } });
        await pollUntilIndexed(recordForOrg.id!, 'record');
        await pollUntilIndexed(recordTenantOnly.id!, 'record');

        try {
            const minted = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:r', 'search:r'],
                    dataScope: { 'scope:org': [org.id!] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            // listRecords narrowed by `scope` — only the org-tagged record.
            const list = await scoped.records.listRecords({
                type: recordType,
                scope: `org:${org.id}`,
            });
            const listedIds = (list.data ?? []).map((r) => r.id);
            expect(listedIds).toContain(recordForOrg.id);
            expect(listedIds).not.toContain(recordTenantOnly.id);

            // Search — same null-sentinel rules as the client-scope test above:
            // strict-scope mode requires `scope` in the request when the token's
            // dataScope `scope:org` is a single value; include `null` in the
            // dataScope value list to opt in to tenant-level records.
            const results = await scoped.search.content({
                query: uniquePhrase,
                mode: 'TEXT',
                limit: 100,
                scope: `org:${org.id}`,
            });
            const hitIds = (results.results ?? []).map((r) => r.documentId);
            expect(hitIds).toContain(recordForOrg.id);
            expect(hitIds).not.toContain(recordTenantOnly.id);
        } finally {
            await tryCleanup('record (org)', () =>
                client.records.deleteRecord({ id: recordForOrg.id! }));
            await tryCleanup('record (tenant)', () =>
                client.records.deleteRecord({ id: recordTenantOnly.id! }));
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schema.id! }));
            await tryCleanup('org', () =>
                client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
        }
    });
});
