/**
 * public-view-projection.spec.ts — public views in `projection` mode.
 *
 * A record type can make some of its fields public: `publicView: { mode: 'projection', fields: [...] }`.
 * Each published record then has a public copy holding only those fields. This spec checks the
 * contract an owner can observe with their own key (anonymous reads are not part of this release):
 *
 *   1. publish: a record of the type has a copy, `GET /v1/records/{id}/public-view` returns ONLY the
 *      listed fields, never the private one;
 *   2. unpublish: archiving the record unpublishes it (`published: false`, no fields);
 *   3. erasure: erasing the owner deletes the record; its public view then answers 404, and the certificate counts the record as
 *      deleted, never as a shared row skipped. Opt-in: set `PUBLIC_VIEW_ERASURE_CHECK=1` to run it (about 10 minutes).
 *
 * What this spec CANNOT see: whether the copy ROW is gone. Copies are not addressable over the API, so the row-level
 * guarantees (the copy deleted in the record's own transaction, zero copy rows after erasure) are not checked here.
 *
 * PRECONDITION: public access must be turned on for the test tenant of the key's account (the account owner
 * turns it on). The key is `VECTROS_RUN_SMOKE_API_KEY` when set, otherwise `VECTROS_API_KEY`. Without that switch
 * the schema write is refused with `PUBLIC_ACCESS_NOT_ENABLED`, and this spec FAILS saying so, rather than
 * skipping: a skipped run is not evidence.
 *
 * The new routes are called over HTTP directly, so the spec does not depend on an SDK release that has them.
 */
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { uniqueTag, tryCleanup, sleep, SKIP_SLOW } from '../src/helpers';

type Json = Record<string, any>;
interface Reply { status: number; body: Json }

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

async function call(method: string, path: string, body?: Json): Promise<Reply> {
    const key = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
    if (!key) throw new Error('VECTROS_API_KEY (or VECTROS_RUN_SMOKE_API_KEY) required');
    const resp = await rateLimitAwareFetch(`${baseUrl()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: resp.status, body: parsed };
}

function expectStatus(r: Reply, status: number): void {
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}

/** Creates a projection-mode type owned by `scope:org`: title and city public, phone private. */
async function createProjectionType(): Promise<{ typeName: string; schemaId: string }> {
    const typeName = `smoke_pvproj_${uniqueTag()}`;
    const r = await call('POST', '/v1/schemas', {
        typeName, displayName: 'Public view projection probe', indexMode: 'NONE', allowedSurfaces: ['record'],
        fields: [
            { fieldId: 'title', fieldType: 'string' },
            { fieldId: 'city', fieldType: 'string' },
            { fieldId: 'phone', fieldType: 'string' },
        ],
        publicView: { mode: 'projection', ownedBy: ['scope:org'], fields: ['title', 'city'] },
    });
    if (r.status === 409 && r.body.errorCode === 'PUBLIC_ACCESS_NOT_ENABLED') {
        throw new Error('PRECONDITION: public access is not turned on for this account; the account owner must enable it before this spec can run.');
    }
    expectStatus(r, 201);
    expect(r.body.publicView.mode).toBe('projection');
    expect(r.body.publicView.fields).toEqual(['title', 'city']);
    expect(typeof r.body.publicView.publicViewVersion).toBe('number');
    return { typeName, schemaId: r.body.id };
}

describe('public views: projection mode', () => {
    const schemasToRemove: string[] = [];
    afterAll(async () => {
        for (const id of schemasToRemove) await tryCleanup('schema', () => call('DELETE', `/v1/schemas/${id}`));
    });

    test('publish shows only the listed fields; archiving unpublishes the record', async () => {
        const orgReply = await call('POST', '/v1/entities/org', { externalId: 'pvproj-org-' + uniqueTag(), name: 'Projection Org' });
        expectStatus(orgReply, 201);
        const org = { id: orgReply.body.id as string };
        const { typeName, schemaId } = await createProjectionType();
        schemasToRemove.push(schemaId);

        const created = await call('POST', '/v1/records', {
            typeName, schemaId, scopes: [`org:${org.id}`],
            payload: { title: 'Beach cleanup', city: 'Leeds', phone: '07700 900123' },
        });
        expectStatus(created, 201);
        const id = created.body.id as string;
        try {
            const view = await call('GET', `/v1/records/${id}/public-view`);
            expectStatus(view, 200);
            expect(view.body.published).toBe(true);
            expect(view.body.recordId).toBe(id);
            expect(view.body.fields).toEqual({ title: 'Beach cleanup', city: 'Leeds' });
            expect(JSON.stringify(view.body)).not.toContain('07700');
            expect(typeof view.body.publicId).toBe('string');

            // the copy is not a record you can address or list
            const list = await call('GET', `/v1/schemas?limit=100`);
            expectStatus(list, 200);
            expect(Array.isArray(list.body.data)).toBe(true);
            for (const s of list.body.data) expect(String(s.typeName).toLowerCase().startsWith('pv_')).toBe(false);

            const archived = await call('PUT', `/v1/records/${id}`, { status: 'ARCHIVED' });
            expectStatus(archived, 200);
            const after = await call('GET', `/v1/records/${id}/public-view`);
            expectStatus(after, 200);
            expect(after.body.published).toBe(false);
            expect(after.body.fields).toBeUndefined();
        } finally {
            await tryCleanup('record', () => call('DELETE', `/v1/records/${id}`));
        }
    }, 120_000);

    // OPT-IN: set PUBLIC_VIEW_ERASURE_CHECK=1 (and leave SMOKE_SKIP_SLOW unset); it takes roughly 10 minutes.
    (SKIP_SLOW || process.env.PUBLIC_VIEW_ERASURE_CHECK !== '1' ? test.skip : test)('erasing the owner deletes the record, its public view answers 404, and the certificate counts the record', async () => {
        const orgReply = await call('POST', '/v1/entities/org', { externalId: 'pvproj-erase-' + uniqueTag(), name: 'Projection Erase Org' });
        expectStatus(orgReply, 201);
        const org = { id: orgReply.body.id as string };
        const { typeName, schemaId } = await createProjectionType();
        schemasToRemove.push(schemaId);
        const created = await call('POST', '/v1/records', {
            typeName, schemaId, scopes: [`org:${org.id}`], payload: { title: 'To be erased', phone: '07700 900456' },
        });
        expectStatus(created, 201);
        const id = created.body.id as string;
        expect((await call('GET', `/v1/records/${id}/public-view`)).body.published).toBe(true);

        const submitted = await call('POST', '/v1/erasure-requests', { subjectType: 'org', subjectId: org.id, contextScope: ['default'] });
        expect([200, 201, 202]).toContain(submitted.status);
        const requestId = submitted.body.requestId as string;
        const deadline = Date.now() + 1_200_000;
        let done: Json = {};
        while (Date.now() < deadline) {
            done = (await call('GET', `/v1/erasure-requests/${requestId}`)).body;
            if (done.status === 'completed' || done.status === 'failed') break;
            await sleep(10_000);
        }
        if (done.status !== 'completed') throw new Error(`erasure request ${requestId} ended ${JSON.stringify(done)}`);
        // the record is gone, so its public view is too (the route reads through the record; the copy row itself is not visible here)
        expect((await call('GET', `/v1/records/${id}`)).status).toBe(404);
        expect((await call('GET', `/v1/records/${id}/public-view`)).status).toBe(404);
        // a public type's owned record is counted as deleted, never as a shared row skipped
        expect(done.certificate).toBeDefined();
        expect(done.certificate.sharedRowsSkipped).toBe(0);
    }, 1_500_000);

    test('republish answers with its progress, and a second request returns the running one', async () => {
        const { schemaId } = await createProjectionType();
        schemasToRemove.push(schemaId);
        const first = await call('POST', `/v1/schemas/${schemaId}/republish`);
        expectStatus(first, 202);
        expect(['RUNNING', 'COMPLETE']).toContain(first.body.status);
        const second = await call('POST', `/v1/schemas/${schemaId}/republish`);
        expectStatus(second, 202);
        if (second.body.status === 'RUNNING') expect(second.body.startedAt).toBe(first.body.startedAt);
        const state = await call('GET', `/v1/schemas/${schemaId}/republish`);
        expectStatus(state, 200);
        expect(state.body.schemaId).toBe(schemaId);
    }, 60_000);

    test('the reserved pv_ prefix and projection refusals answer stable codes', async () => {
        const reserved = await call('POST', '/v1/schemas', {
            typeName: `pv_smoke_${uniqueTag()}`, displayName: 'x', allowedSurfaces: ['record'], fields: [{ fieldId: 'title', fieldType: 'string' }],
        });
        expectStatus(reserved, 400);
        expect(reserved.body.errorCode).toBe('PUBLIC_VIEW_RESERVED_TYPE_NAME');

        const noFields = await call('POST', '/v1/schemas', {
            typeName: `smoke_pvnof_${uniqueTag()}`, displayName: 'x', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'title', fieldType: 'string' }], publicView: { ownedBy: ['scope:org'] },
        });
        expectStatus(noFields, 400);
        expect(noFields.body.errorCode).toBe('PUBLIC_VIEW_FIELDS_INVALID');
    }, 60_000);
});
