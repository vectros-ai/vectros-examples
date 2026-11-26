/**
 * public-search-sort.spec.ts — an anonymous public search ordered by a field, live: `GET /v1/public/search?sortBy=<field>&order=...`.
 *
 * An anonymous search ordered by a field: ascending and descending, records without a value last, the same order on every page. This spec
 * runs that end to end, through the edge, on the account the key belongs to:
 *
 *   1. it creates a `record`-mode type with a filterable `startsAt` (`instant`), `price` (`number`) and `day` (`date`) and a filterable
 *      string array `causes`, offering `text` search, with `cacheSeconds: 0` so no answer is served from the edge cache;
 *   2. it writes records whose `startsAt` differ by a millisecond, a record at the earliest and one at the latest storable moment, and a
 *      record with no `startsAt`;
 *   3. `sortBy=startsAt` with no `q` lists them soonest first, `order=desc` latest first, the record with no value last either way;
 *   4. the same order is served on every page: paging one record at a time returns the full page's order;
 *   5. a range from a moment on, ordered by the same field, lists the records from that moment, soonest first;
 *   6. a `number` and a `date` field order the same way;
 *   7. a field that is not a public filterable `number`, `date` or `instant` field, an `order` that is not `asc` or `desc`, a mode other
 *      than `text`, and `sortBy` with `near.*` are each refused `400`.
 *
 * PRECONDITIONS, on the account of `VECTROS_RUN_SMOKE_API_KEY` (when set, otherwise `VECTROS_API_KEY`): public access is turned on, a
 * public budget is chosen, and the account owner allows public `text` search. Each missing precondition FAILS the spec, naming it.
 *
 * Each search is billed as one public text search. A flagged page with no results is not billed. An ordered search weighs 12 against the
 * visitor's rate limit, so the spec retries a `429` after its `Retry-After`. The records, the type and the user are removed when the
 * spec ends. A key the spec did not issue is never revoked; a key it issued is left active (revoking one also revokes every older key of
 * its app context), and the next run reuses it.
 */
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { uniqueTag, tryCleanup, sleep } from '../src/helpers';

type Json = Record<string, any>;
interface Reply { status: number; body: Json; retryAfter?: string | null }

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function parse(text: string): Json {
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

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

/** An anonymous search with the publishable key in `k`; a 429 or a busy 503 is retried after its Retry-After (up to 6 tries). */
async function search(appKey: string, params: Record<string, string>): Promise<Reply> {
    const query = new URLSearchParams({ k: appKey, ...params });
    for (let attempt = 1; ; attempt++) {
        const resp = await fetch(`${baseUrl()}/v1/public/search?${query.toString()}`, { headers: { Accept: 'application/json' } });
        const reply: Reply = { status: resp.status, body: parse(await resp.text()), retryAfter: resp.headers.get('retry-after') };
        if ((reply.status !== 429 && reply.status !== 503) || attempt >= 6) return reply;
        await sleep(Math.min(65, Math.max(5, Number(reply.retryAfter) || 15)) * 1000);
    }
}

async function removed(r: Promise<Reply>): Promise<Reply> {
    const reply = await r;
    if (reply.status >= 300 && reply.status !== 404) throw new Error(`cleanup answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    return reply;
}

function expectStatus(r: Reply, status: number): void {
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}

function assertPreconditions(r: Reply): void {
    const code = r.body.errorCode;
    if (code === 'PUBLIC_ACCESS_NOT_ENABLED') {
        throw new Error('PRECONDITION: public access is not turned on for this account; the account owner must enable it before this spec can run.');
    }
    if (code === 'PUBLIC_BUDGET_MODE_UNSET') {
        throw new Error('PRECONDITION: no public budget is chosen for this account; the account owner must choose one before this spec can run.');
    }
    if (code === 'PUBLIC_SEARCH_UNAVAILABLE') {
        throw new Error('PRECONDITION: the account owner does not allow public text search on this account; allow it before this spec can run.');
    }
}

interface KeyRow { keyId: string; appKey?: string; contextId?: string; keyClass?: string; version?: number; status?: string }

async function browserKey(): Promise<string> {
    const keys = await call('GET', '/v1/admin/public-keys?limit=100');
    expectStatus(keys, 200);
    const existing = ((keys.body.data ?? []) as KeyRow[])
        .filter((k) => k.contextId === 'default' && k.status === 'ACTIVE' && k.keyClass === 'pub' && k.appKey)
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
    if (existing) return existing.appKey!;
    const made = await call('POST', '/v1/admin/public-keys', { keyClass: 'pub' });
    assertPreconditions(made);
    expectStatus(made, 201);
    return (made.body as KeyRow).appKey!;
}

const publicIds = (r: Reply): string[] => ((r.body.data ?? []) as Json[]).map((h) => h.publicId as string);

/** Records, soonest first by `startsAt`. B follows A by one millisecond; NONE has no `startsAt` (and no `price` or `day`). */
const RECORDS: Array<{ label: string; startsAt?: string; price?: number; day?: string }> = [
    { label: 'MIN', startsAt: '0001-01-01T00:00:00.000Z', price: 40, day: '2026-11-22' },
    { label: 'A', startsAt: '2026-11-20T12:00:00.000Z', price: 10, day: '2026-11-20' },
    { label: 'B', startsAt: '2026-11-20T12:00:00.001Z', price: 30, day: '2026-11-21' },
    { label: 'C', startsAt: '2026-11-20T12:00:01.000Z', price: 20, day: '2026-11-19' },
    { label: 'MAX', startsAt: '9999-12-31T23:59:59.999Z', price: 5, day: '2026-11-23' },
    { label: 'NONE' },
];

describe('public search: ordered by a field', () => {
    let schemaId: string | undefined;
    let userId: string | undefined;
    let appKey = '';
    let typeName = '';
    const recordIds: string[] = [];
    const labelByPublicId: Record<string, string> = {};

    afterAll(async () => {
        for (const id of recordIds) await tryCleanup('record', () => removed(call('DELETE', `/v1/records/${id}`)));
        if (schemaId) await tryCleanup('schema', () => removed(call('DELETE', `/v1/schemas/${schemaId}`)));
        if (userId) await tryCleanup('user', () => removed(call('DELETE', `/v1/users/${userId}`)));
    });

    const order = (r: Reply): string[] => publicIds(r).map((id) => labelByPublicId[id]);

    beforeAll(async () => {
        const tag = uniqueTag().replace(/[^a-z0-9]/gi, '').toLowerCase();
        typeName = `smoke_pubsort_${tag}`;
        const type = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Public sort probe', indexMode: 'TEXT', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', searchable: true },
                { fieldId: 'state', fieldType: 'string', filterable: true },
                { fieldId: 'startsAt', fieldType: 'instant', filterable: true },
                { fieldId: 'price', fieldType: 'number', filterable: true },
                { fieldId: 'day', fieldType: 'date', filterable: true },
                { fieldId: 'causes', fieldType: 'array', itemType: 'string', filterable: true },
            ],
            lookupFields: [{ fieldName: 'state' }],
            publicView: { mode: 'record', ownedBy: ['userId'], publishWhen: { field: 'state', in: ['open'] }, search: ['text'], cacheSeconds: 0 },
        });
        assertPreconditions(type);
        expectStatus(type, 201);
        schemaId = type.body.id as string;

        const user = await call('POST', '/v1/users', { externalId: `pubsort-${tag}`, email: `pubsort-${tag}@example.com` });
        if (user.status >= 300) throw new Error(`creating the owner user answered ${user.status}: ${JSON.stringify(user.body)}`);
        userId = user.body.id as string;

        for (const rec of RECORDS) {
            const { label, ...values } = rec;
            const r = await call('POST', '/v1/records', {
                typeName, schemaId, userId, payload: { title: `Beach cleanup ${label}`, state: 'open', causes: ['coast'], ...values },
            });
            expectStatus(r, 201);
            recordIds.push(r.body.id as string);
            labelByPublicId[r.body.publicId as string] = label;
        }
        appKey = await browserKey();

        // the records are indexed shortly after the write, and a new key reaches the edge shortly after its issue: poll until all show
        let page: Reply = { status: 0, body: {} };
        const deadline = Date.now() + 180_000;
        for (let poll = 0; Date.now() < deadline; poll++) {
            // a different limit per poll is a different cache key, so a poll never re-reads an earlier empty page
            page = await search(appKey, { type: typeName, 'filter.causes': 'coast', limit: String(10 + (poll % 20)) });
            assertPreconditions(page);
            if (page.status === 200 && publicIds(page).length >= RECORDS.length) break;
            await sleep(10_000);
        }
        expectStatus(page, 200);
        expect(publicIds(page)).toHaveLength(RECORDS.length);
    }, 420_000);

    test('orders by an instant to the millisecond: soonest first, latest first, the record with no value last either way', async () => {
        const asc = await search(appKey, { type: typeName, sortBy: 'startsAt' });
        assertPreconditions(asc);
        expectStatus(asc, 200);
        expect(order(asc)).toEqual(['MIN', 'A', 'B', 'C', 'MAX', 'NONE']);
        const explicitAsc = await search(appKey, { type: typeName, sortBy: 'startsAt', order: 'asc' });
        expectStatus(explicitAsc, 200);
        expect(order(explicitAsc)).toEqual(['MIN', 'A', 'B', 'C', 'MAX', 'NONE']);
        const desc = await search(appKey, { type: typeName, sortBy: 'startsAt', order: 'desc' });
        expectStatus(desc, 200);
        expect(order(desc)).toEqual(['MAX', 'C', 'B', 'A', 'MIN', 'NONE']);
    }, 120_000);

    test('serves the same order on every page', async () => {
        const full = await search(appKey, { type: typeName, sortBy: 'startsAt', limit: '10' });
        expectStatus(full, 200);
        const paged: string[] = [];
        for (let offset = 0; offset < RECORDS.length; offset++) {
            const page = await search(appKey, { type: typeName, sortBy: 'startsAt', limit: '1', offset: String(offset) });
            expectStatus(page, 200);
            expect(publicIds(page)).toHaveLength(1);
            paged.push(publicIds(page)[0]);
        }
        expect(paged).toEqual(publicIds(full));
    }, 180_000);

    test('lists the records from a moment on, soonest first, and orders with a q', async () => {
        const from = await search(appKey, { type: typeName, 'filter.startsAt.from': '2026-11-20T12:00:00.001Z', sortBy: 'startsAt' });
        expectStatus(from, 200);
        expect(order(from)).toEqual(['B', 'C', 'MAX']);
        const withQuery = await search(appKey, { type: typeName, q: 'Beach cleanup', mode: 'text', sortBy: 'startsAt', order: 'desc' });
        expectStatus(withQuery, 200);
        expect(order(withQuery)).toEqual(['MAX', 'C', 'B', 'A', 'MIN', 'NONE']);
    }, 120_000);

    test('orders by a number and by a date', async () => {
        const byPrice = await search(appKey, { type: typeName, sortBy: 'price' });
        expectStatus(byPrice, 200);
        expect(order(byPrice)).toEqual(['MAX', 'A', 'C', 'B', 'MIN', 'NONE']);
        const byDay = await search(appKey, { type: typeName, sortBy: 'day', order: 'desc' });
        expectStatus(byDay, 200);
        expect(order(byDay)).toEqual(['MAX', 'MIN', 'B', 'A', 'C', 'NONE']);
    }, 120_000);

    test('refuses a field that cannot be sorted by, a bad order, a mode other than text, and near.*', async () => {
        for (const sortBy of ['causes', 'title', 'nosuchfield', 'distance']) {
            const r = await search(appKey, { type: typeName, sortBy });
            expectStatus(r, 400);
            expect(r.body.errorCode).toBe('PUBLIC_SEARCH_SORT_NOT_ALLOWED');
        }
        const badOrder = await search(appKey, { type: typeName, sortBy: 'startsAt', order: 'sideways' });
        expectStatus(badOrder, 400);
        const orderOnly = await search(appKey, { type: typeName, order: 'desc', 'filter.causes': 'coast' });
        expectStatus(orderOnly, 400);
        const semantic = await search(appKey, { type: typeName, q: 'beach', mode: 'semantic', sortBy: 'startsAt' });
        expectStatus(semantic, 400);
        expect(semantic.body.errorCode).toBe('PUBLIC_SEARCH_SORT_NOT_ALLOWED');
        const near = await search(appKey, { type: typeName, sortBy: 'startsAt', 'near.lat': '38.7223', 'near.lon': '-9.1393', 'near.radius': '5000' });
        expectStatus(near, 400);
        expect(near.body.errorCode).toBe('PUBLIC_SEARCH_SORT_NOT_ALLOWED');
    }, 180_000);
});
