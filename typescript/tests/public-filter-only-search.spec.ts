/**
 * public-filter-only-search.spec.ts — public search with filters and no `q`, live: `GET /v1/public/search?filter.<field>=...`.
 *
 * A type whose public view offers `text` search lists the published records that match a filter when the request sends at least one
 * `filter.<field>` and no `q`. This spec runs that path end to end, through the edge, on the account the key belongs to:
 *
 *   1. it creates a `record`-mode type that publishes the records whose `state` is `open`, with a filterable `city` and a filterable
 *      string array `causes`, offering `text` search, with `cacheSeconds: 0` so no answer is served from the edge cache;
 *   2. it writes three open records in one city (one with a cause the others lack), one DRAFT record in the same city, and one open
 *      record in another city;
 *   3. `filter.city=<city>` with no `q` returns exactly the three open records of that city: never the draft, never the other city;
 *   4. paging that list one record at a time returns the same three, each once, in the same order as the full page;
 *   5. `filter.city=<city>&filter.causes=<cause>` with no `q` matches the open record of that city whose array holds that element, and
 *      only it (the draft and the other city's record hold it too);
 *   6. no `q`, no `near.*` and no filter is still refused `400`, as is `mode=hybrid` with filters and no `q`.
 *
 * PRECONDITIONS, on the account of `VECTROS_RUN_SMOKE_API_KEY` (when set, otherwise `VECTROS_API_KEY`): public access is turned on,
 * a public budget is chosen, and the account owner allows public `text` search. Each missing precondition FAILS the spec, naming it.
 *
 * Each search is billed as one public text search. A flagged page with no results is not billed. A search with filters and no `q` weighs 12
 * against the visitor's rate limit, so the spec retries a `429` after its `Retry-After`.
 *
 * The records, the type and the user are removed when the spec ends. A key the spec did not issue is never revoked; a key it issued is
 * left active (revoking one also revokes every older key of its app context), and the next run reuses it.
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

describe('public search: filters with no q', () => {
    let schemaId: string | undefined;
    let userId: string | undefined;
    const recordIds: string[] = [];
    afterAll(async () => {
        for (const id of recordIds) await tryCleanup('record', () => removed(call('DELETE', `/v1/records/${id}`)));
        if (schemaId) await tryCleanup('schema', () => removed(call('DELETE', `/v1/schemas/${schemaId}`)));
        if (userId) await tryCleanup('user', () => removed(call('DELETE', `/v1/users/${userId}`)));
    });

    test('lists the published records that match, in a stable order, never a draft, and matches an array element', async () => {
        const tag = uniqueTag().replace(/[^a-z0-9]/gi, '').toLowerCase();
        const typeName = `smoke_pubfilter_${tag}`;
        const type = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Public filter-only probe', indexMode: 'TEXT', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', searchable: true },
                { fieldId: 'state', fieldType: 'string', filterable: true },
                { fieldId: 'city', fieldType: 'string', filterable: true },
                { fieldId: 'causes', fieldType: 'array', itemType: 'string', filterable: true },
            ],
            lookupFields: [{ fieldName: 'state' }],
            publicView: { mode: 'record', ownedBy: ['userId'], publishWhen: { field: 'state', in: ['open'] }, search: ['text'], cacheSeconds: 0 },
        });
        assertPreconditions(type);
        expectStatus(type, 201);
        schemaId = type.body.id as string;

        const user = await call('POST', '/v1/users', { externalId: `pubfilter-${tag}`, email: `pubfilter-${tag}@example.com` });
        if (user.status >= 300) throw new Error(`creating the owner user answered ${user.status}: ${JSON.stringify(user.body)}`);
        userId = user.body.id as string;

        // a city no other record holds, so the list can only be this spec's records
        const city = `city${tag}`;
        const cause = `cause${tag}`;
        const write = async (title: string, state: string, recordCity: string, causes: string[]): Promise<string> => {
            const r = await call('POST', '/v1/records', { typeName, schemaId, userId, payload: { title, state, city: recordCity, causes } });
            expectStatus(r, 201);
            recordIds.push(r.body.id as string);
            expect(r.body.publicState).toBe(state === 'open' ? 'PUBLISHED' : 'UNPUBLISHED');
            return r.body.publicId as string;
        };
        const open1 = await write('Beach cleanup one', 'open', city, ['coast']);
        const open2 = await write('Beach cleanup two', 'open', city, ['coast', cause]);
        const open3 = await write('Beach cleanup three', 'open', city, ['parks']);
        const draft = await write('Beach cleanup draft', 'draft', city, [cause]);
        const elsewhere = await write('Beach cleanup elsewhere', 'open', `other${tag}`, [cause]);
        const expected = [open1, open2, open3].map(String).sort();

        const appKey = await browserKey();

        // the records are indexed shortly after the write, and a new key reaches the edge shortly after its issue: poll until all three show
        let all: Reply = { status: 0, body: {} };
        const deadline = Date.now() + 180_000;
        for (let poll = 0; Date.now() < deadline; poll++) {
            // a different limit per poll is a different cache key, so a poll never re-reads an earlier empty page
            all = await search(appKey, { type: typeName, [`filter.city`]: city, limit: String(10 + (poll % 20)) });
            assertPreconditions(all);
            if (all.status === 200 && publicIds(all).length >= 3) break;
            await sleep(10_000);
        }
        expectStatus(all, 200);
        expect([...publicIds(all)].sort()).toEqual(expected);
        expect(publicIds(all)).not.toContain(elsewhere);
        expect(publicIds(all)).not.toContain(draft);
        expect(all.body.hasMore).toBe(false);

        // one record per page: the same three, each once, in the full page's order
        const paged: string[] = [];
        for (let offset = 0; offset < 3; offset++) {
            const page = await search(appKey, { type: typeName, 'filter.city': city, limit: '1', offset: String(offset) });
            expectStatus(page, 200);
            expect(publicIds(page)).toHaveLength(1);
            expect(publicIds(page)).not.toContain(draft);
            paged.push(publicIds(page)[0]);
        }
        expect(paged).toEqual(publicIds(all));

        // an array element: only the open record of this city whose causes hold it (the draft and the other city hold it too)
        const byCause = await search(appKey, { type: typeName, 'filter.city': city, 'filter.causes': cause });
        expectStatus(byCause, 200);
        expect(publicIds(byCause)).toEqual([open2]);

        // still refused: no q, no near.* and no filter; and a mode other than text with no q
        const none = await search(appKey, { type: typeName });
        expectStatus(none, 400);
        const hybrid = await search(appKey, { type: typeName, 'filter.city': city, mode: 'hybrid' });
        expectStatus(hybrid, 400);
    }, 420_000);
});
