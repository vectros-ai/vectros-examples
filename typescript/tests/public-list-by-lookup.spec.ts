/**
 * public-list-by-lookup.spec.ts — anonymous public list of a `projection` type by a published lookup field, live:
 * `GET /v1/public/records/{type}?<field>=<value>` with a publishable key.
 *
 * The shape: a parent page lists its published children by the parent's id. This spec runs it end to end, through the edge, on the
 * account the key belongs to:
 *
 *   1. it creates a `projection` type `shift`: `title` and `opportunityId` public, `contactPhone` private, published only while
 *      `listingState` is `published` (`publishWhen`), with lookups on `listingState` and `opportunityId`, and `cacheSeconds: 0` so no answer
 *      is served from the edge cache;
 *   2. it writes, for one opportunity, two published shifts with a draft between them, and one published shift of another opportunity;
 *   3. it uses an ACTIVE browser key (`pub_...`) of the default app context when one exists, and issues one only when none does;
 *   4. an anonymous list by `opportunityId`, one record per page, returns exactly the two published shifts of that opportunity, every page
 *      before the last full, only the public fields (never the private one, never a record id), and opaque cursors;
 *   5. unpublishing one of them (setting `listingState` to `draft`) removes it from the list;
 *   6. listing by the private field is the same 404 as a type with no public records.
 *
 * The record ids, the type and the org are removed when the spec ends. A key the spec did not issue is never revoked. Revoking a key also
 * revokes EVERY older key of its app context, so a key the spec issued is revoked only when no older key of the context is still active
 * (checked again at cleanup); otherwise it is left active, and the next run reuses it.
 *
 * PRECONDITIONS, on the account of `VECTROS_RUN_SMOKE_API_KEY` (when set, otherwise `VECTROS_API_KEY`): public access is turned on and a
 * public budget is chosen (both the account owner's). Each missing precondition FAILS the spec, naming it, rather than skipping: a skipped
 * run is not evidence.
 *
 * Each list page is charged as one public read to the account.
 *
 * The routes are called over HTTP directly, so the spec does not depend on an SDK release that has them.
 */
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { uniqueTag, tryCleanup, sleep } from '../src/helpers';

type Json = Record<string, any>;
interface Reply { status: number; body: Json }

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function parse(text: string): Json {
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

/** An owner call, with the key of the account that has public access on. */
async function call(method: string, path: string, body?: Json): Promise<Reply> {
    const key = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
    if (!key) throw new Error('VECTROS_API_KEY (or VECTROS_RUN_SMOKE_API_KEY) required');
    const resp = await rateLimitAwareFetch(`${baseUrl()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: resp.status, body: parse(await resp.text()) };
}

/** An anonymous list: the publishable key in `k`, no other credential. */
async function publicList(appKey: string, typeName: string, query: Record<string, string>): Promise<Reply> {
    const q = new URLSearchParams({ ...query, k: appKey });
    const resp = await rateLimitAwareFetch(`${baseUrl()}/v1/public/records/${encodeURIComponent(typeName)}?${q.toString()}`,
        { headers: { Accept: 'application/json' } });
    return { status: resp.status, body: parse(await resp.text()) };
}

/** For cleanup: a failed removal throws, so `tryCleanup` reports it; a 404 (already gone) is fine. */
async function removed(r: Promise<Reply>): Promise<Reply> {
    const reply = await r;
    if (reply.status >= 300 && reply.status !== 404) throw new Error(`cleanup answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    return reply;
}

function expectStatus(r: Reply, status: number): void {
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}

/** Fails with the unmet precondition, when the reply is one, rather than with a confusing status mismatch. */
function assertPreconditions(r: Reply): void {
    const code = r.body.errorCode;
    if (code === 'PUBLIC_ACCESS_NOT_ENABLED') {
        throw new Error('PRECONDITION: public access is not turned on for this account; the account owner must enable it before this spec can run.');
    }
    if (code === 'PUBLIC_BUDGET_MODE_UNSET') {
        throw new Error('PRECONDITION: no public budget is chosen for this account; the account owner must choose one before this spec can run.');
    }
}

interface KeyRow { keyId: string; appKey?: string; contextId?: string; keyClass?: string; version?: number; status?: string }

/** Every publishable key of the account (the list pages through `nextCursor`). */
async function allKeys(): Promise<KeyRow[]> {
    const out: KeyRow[] = [];
    for (let startFrom: string | undefined, pages = 0; pages < 50; pages++) {
        const page = await call('GET', `/v1/admin/public-keys?limit=100${startFrom ? `&startFrom=${encodeURIComponent(startFrom)}` : ''}`);
        expectStatus(page, 200);
        out.push(...(page.body.data ?? []));
        startFrom = page.body.nextCursor ?? undefined;
        if (!startFrom) break;
    }
    return out;
}

const activeDefault = (k: KeyRow) => k.contextId === 'default' && k.status === 'ACTIVE';

/** Every page of a list by one field, one record per page: the publicIds served, each page's size, every cursor and every body. */
async function everyPage(appKey: string, typeName: string, field: string, value: string): Promise<{ ids: string[]; sizes: number[]; cursors: string[]; bodies: string }> {
    const ids: string[] = [], sizes: number[] = [], cursors: string[] = [];
    let bodies = '';
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
        const r = await publicList(appKey, typeName, { [field]: value, limit: '1', ...(cursor ? { cursor } : {}) });
        assertPreconditions(r);
        expectStatus(r, 200);
        bodies += JSON.stringify(r.body);
        sizes.push((r.body.data ?? []).length);
        for (const item of r.body.data ?? []) ids.push(item.publicId as string);
        cursor = r.body.nextCursor ?? undefined;
        if (!cursor) break;
        cursors.push(cursor);
    }
    return { ids, sizes, cursors, bodies };
}

describe('public list: a projection type listed by a published lookup', () => {
    let schemaId: string | undefined;
    let orgId: string | undefined;
    const recordIds: string[] = [];
    /** A key THIS spec issued (never one it found): the only key it may revoke. */
    let issued: KeyRow | undefined;
    afterAll(async () => {
        if (issued) {
            const mine = issued;
            await tryCleanup('publishable key', async () => {
                const older = (await allKeys()).filter((k) => activeDefault(k) && k.keyId !== mine.keyId && (k.version ?? 0) < (mine.version ?? 0));
                if (older.length > 0) return;   // left active: the next run reuses it
                await removed(call('DELETE', `/v1/admin/public-keys/${mine.keyId}`));
            });
        }
        for (const id of recordIds) await tryCleanup('record', () => removed(call('DELETE', `/v1/records/${id}`)));
        if (schemaId) await tryCleanup('schema', () => removed(call('DELETE', `/v1/schemas/${schemaId}`)));
        if (orgId) await tryCleanup('org', () => removed(call('DELETE', `/v1/entities/org/${orgId}`)));
    });

    test('lists exactly the published records of one value, in full pages, and drops one that is unpublished', async () => {
        const orgReply = await call('POST', '/v1/entities/org', { externalId: 'publist-org-' + uniqueTag(), name: 'Public List Org' });
        expectStatus(orgReply, 201);
        orgId = orgReply.body.id as string;

        const typeName = `smoke_shift_${uniqueTag()}`;
        const type = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Public list probe', indexMode: 'NONE', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string' },
                { fieldId: 'opportunityId', fieldType: 'string' },
                { fieldId: 'contactPhone', fieldType: 'string' },
                { fieldId: 'listingState', fieldType: 'string', filterable: true },
            ],
            lookupFields: [{ fieldName: 'listingState' }, { fieldName: 'opportunityId' }],
            publicView: {
                mode: 'projection', ownedBy: ['scope:org'], fields: ['title', 'opportunityId'], cacheSeconds: 0,
                publishWhen: { field: 'listingState', in: ['published'] },
            },
        });
        assertPreconditions(type);
        expectStatus(type, 201);
        schemaId = type.body.id as string;

        const opportunity = `opp-${uniqueTag()}`;
        const other = `opp-${uniqueTag()}`;
        const write = async (title: string, opp: string, state: string): Promise<string> => {
            const r = await call('POST', '/v1/records', {
                typeName, schemaId, scopes: [`org:${orgId}`],
                payload: { title, opportunityId: opp, contactPhone: '07700 900123', listingState: state },
            });
            expectStatus(r, 201);
            recordIds.push(r.body.id as string);
            return r.body.id as string;
        };
        const morning = await write('Morning', opportunity, 'published');
        const draft = await write('Draft', opportunity, 'draft');
        const evening = await write('Evening', opportunity, 'published');
        await write('Elsewhere', other, 'published');
        const publicIdOf = async (id: string): Promise<string | undefined> => {
            const v = await call('GET', `/v1/records/${id}/public-view`);
            expectStatus(v, 200);
            return v.body.published ? (v.body.publicId as string) : undefined;
        };
        const expected = [await publicIdOf(morning), await publicIdOf(evening)];
        expect(expected.every((p) => typeof p === 'string')).toBe(true);
        expect(await publicIdOf(draft)).toBeUndefined();

        const existing = (await allKeys()).filter((k) => activeDefault(k) && k.keyClass === 'pub' && k.appKey)
            .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
        let appKey: string;
        if (existing) {
            appKey = existing.appKey!;
        } else {
            const made = await call('POST', '/v1/admin/public-keys', { keyClass: 'pub' });
            assertPreconditions(made);
            expectStatus(made, 201);
            issued = made.body as KeyRow;
            appKey = issued.appKey!;
        }
        expect(appKey).toMatch(/^pub_/);

        // a new key reaches the edge shortly after its issue: poll the first page until it is admitted
        let first: Reply = { status: 0, body: {} };
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            first = await publicList(appKey, typeName, { opportunityId: opportunity, limit: '1' });
            assertPreconditions(first);
            if (first.status === 200) break;
            await sleep(3000);
        }
        expectStatus(first, 200);

        const listed = await everyPage(appKey, typeName, 'opportunityId', opportunity);
        expect([...listed.ids].sort()).toEqual([...expected].sort() as string[]);
        expect(listed.sizes.slice(0, expected.length)).toEqual([1, 1]);   // every page before the end is full: never short by a draft
        expect(listed.sizes.length).toBeLessThanOrEqual(expected.length + 1);
        expect(listed.bodies).not.toContain('07700');
        expect(listed.bodies).not.toContain('listingState');
        for (const id of recordIds) expect(listed.bodies).not.toContain(id);
        for (const c of listed.cursors) expect(c).not.toContain(opportunity);

        // unpublish the evening shift: it leaves the list
        const unpublished = await call('PUT', `/v1/records/${evening}`, {
            typeName, schemaId, scopes: [`org:${orgId}`],
            payload: { title: 'Evening', opportunityId: opportunity, contactPhone: '07700 900123', listingState: 'draft' },
        });
        expectStatus(unpublished, 200);
        const after = await everyPage(appKey, typeName, 'opportunityId', opportunity);
        expect(after.ids).toEqual([expected[0]]);

        // a private field is not listable: the same 404 as a type with no public records
        const hidden = await publicList(appKey, typeName, { listingState: 'published' });
        const missing = await publicList(appKey, `smoke_nosuch_${uniqueTag()}`, { listingState: 'published' });
        expectStatus(hidden, 404);
        expect(hidden.body.errorCode).toBe(missing.body.errorCode);
    }, 240_000);
});
