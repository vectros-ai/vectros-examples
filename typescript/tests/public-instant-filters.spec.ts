/**
 * public-instant-filters.spec.ts — an anonymous public search filtering an `instant` field, live: `GET /v1/public/search`.
 *
 * An anonymous search filters an `instant` field by an exact moment, by a range and by a set; a day is a range from its first
 * millisecond to its last. This spec runs that end to end, through the edge, on the account the key belongs to:
 *
 *   1. it creates a `record`-mode type with a filterable `startsAt` (`instant`) and a filterable `shifts` (an array of `instant`), offering
 *      `text`, `semantic` and `hybrid` search, with `cacheSeconds: 0` so no answer is served from the edge cache;
 *   2. it writes ten records at moments chosen around the millisecond boundaries (the first and last moments of a day, a moment and the
 *      one a millisecond after it, the earliest and latest storable moments) and two records that hold an array of moments;
 *   3. an exact filter matches that millisecond and no other;
 *   4. a range is inclusive at both ends, to the millisecond, so a day is `T00:00:00.000Z` to `T23:59:59.999Z`;
 *   5. a set of moments matches any of them, and an array matches when any element matches;
 *   6. every other spelling of a moment is refused `400`, and so is a range on an array;
 *   7. each answer is the same in the three search modes the type offers, and is the same set of records the authenticated
 *      `POST /v1/search` returns for the same range.
 *
 * PRECONDITIONS, on the account of `VECTROS_RUN_SMOKE_API_KEY` (when set, otherwise `VECTROS_API_KEY`): public access is turned on, a
 * public budget is chosen, and the account owner allows public `text`, `semantic` and `hybrid` search. Each missing precondition FAILS
 * the spec, naming it.
 *
 * Each search is billed as one public search of its mode. A flagged page with no results is not billed. The spec retries a `429` after its
 * `Retry-After`. The records, the type and the user are removed when the spec ends. A key the spec did not issue is never revoked; a key it
 * issued is left active (revoking one also revokes every older key of its app context), and the next run reuses it.
 */
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { uniqueTag, tryCleanup, sleep } from '../src/helpers';

type Json = Record<string, any>;
interface Reply { status: number; body: Json; retryAfter?: string | null }
type Mode = 'text' | 'semantic' | 'hybrid';

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
        throw new Error('PRECONDITION: the account owner does not allow every public search mode on this account; allow text, semantic and hybrid before this spec can run.');
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

/** The moments the records hold. Each pair of neighbours differs by one millisecond or by one second on purpose. */
const MOMENTS: Record<string, string> = {
    H: '2026-11-19T23:59:59.999Z',   // the last millisecond of the day before
    A: '2026-11-20T00:00:00.000Z',   // the first millisecond of the day
    B: '2026-11-20T00:00:00.001Z',
    C: '2026-11-20T12:00:00.000Z',
    D: '2026-11-20T12:00:00.900Z',   // a sub-second moment: the same second as C
    E: '2026-11-20T12:00:01.000Z',
    F: '2026-11-20T23:59:59.999Z',   // the last millisecond of the day
    G: '2026-11-21T00:00:00.000Z',   // the first millisecond of the next day
    MIN: '0001-01-01T00:00:00.000Z', // the earliest storable moment
    MAX: '9999-12-31T23:59:59.999Z', // the latest storable moment
};
/** Records holding an array of moments (and no `startsAt`). */
const SHIFTS: Record<string, string[]> = {
    X: ['2026-11-20T12:00:00.000Z', '2026-11-25T12:00:00.000Z'],
    Y: ['2026-11-22T08:00:00.000Z'],
};
const ms = (iso: string): number => Date.parse(iso);

describe('public search: an instant field', () => {
    let schemaId: string | undefined;
    let userId: string | undefined;
    let appKey = '';
    let typeName = '';
    let title = '';
    const recordIds: string[] = [];
    const labelByPublicId: Record<string, string> = {};
    const labelByRecordId: Record<string, string> = {};

    afterAll(async () => {
        for (const id of recordIds) await tryCleanup('record', () => removed(call('DELETE', `/v1/records/${id}`)));
        if (schemaId) await tryCleanup('schema', () => removed(call('DELETE', `/v1/schemas/${schemaId}`)));
        if (userId) await tryCleanup('user', () => removed(call('DELETE', `/v1/users/${userId}`)));
    });

    /** The labels of the records a public answer holds, sorted. */
    const labels = (r: Reply): string[] => publicIds(r).map((id) => labelByPublicId[id]).sort();

    /** A public search in a mode: with a `q` (the shared title) in the three modes, and with no `q` (filters alone) in text. */
    const publicLabels = async (params: Record<string, string>, mode: Mode | 'filters-only'): Promise<string[]> => {
        // a filter is sent as filter.<field>[.from|.to|.in]; the table below names the field and the bound only
        const base: Record<string, string> = { type: typeName, limit: '40' };
        for (const [name, value] of Object.entries(params)) base[`filter.${name}`] = value;
        const r = await search(appKey, mode === 'filters-only' ? base : { ...base, q: title, mode });
        assertPreconditions(r);
        expectStatus(r, 200);
        return labels(r);
    };

    /** The same range on the authenticated route: its answer is the oracle every public answer is compared with. */
    const authenticatedLabels = async (filters: Json, mode: 'TEXT' | 'SEMANTIC' | 'HYBRID'): Promise<string[]> => {
        const r = await call('POST', '/v1/search', { query: title, mode, typeName, limit: 100, filters });
        expectStatus(r, 200);
        return ((r.body.results ?? []) as Json[]).map((h) => labelByRecordId[h.documentId as string]).filter(Boolean).sort();
    };

    beforeAll(async () => {
        const tag = uniqueTag().replace(/[^a-z0-9]/gi, '').toLowerCase();
        typeName = `smoke_pubinstant_${tag}`;
        title = `Beach cleanup shift ${tag}`;
        const type = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Public instant probe', indexMode: 'HYBRID', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', searchable: true },
                { fieldId: 'state', fieldType: 'string', filterable: true },
                { fieldId: 'startsAt', fieldType: 'instant', filterable: true },
                { fieldId: 'shifts', fieldType: 'array', itemType: 'instant', filterable: true },
            ],
            lookupFields: [{ fieldName: 'state' }],
            publicView: {
                mode: 'record', ownedBy: ['userId'], publishWhen: { field: 'state', in: ['open'] },
                search: ['text', 'semantic', 'hybrid'], cacheSeconds: 0,
            },
        });
        assertPreconditions(type);
        expectStatus(type, 201);
        schemaId = type.body.id as string;

        const user = await call('POST', '/v1/users', { externalId: `pubinstant-${tag}`, email: `pubinstant-${tag}@example.com` });
        if (user.status >= 300) throw new Error(`creating the owner user answered ${user.status}: ${JSON.stringify(user.body)}`);
        userId = user.body.id as string;

        const write = async (label: string, extra: Json): Promise<void> => {
            const r = await call('POST', '/v1/records', { typeName, schemaId, userId, payload: { title, state: 'open', ...extra } });
            expectStatus(r, 201);
            recordIds.push(r.body.id as string);
            labelByPublicId[r.body.publicId as string] = label;
            labelByRecordId[r.body.id as string] = label;
        };
        for (const [label, startsAt] of Object.entries(MOMENTS)) await write(label, { startsAt });
        for (const [label, shifts] of Object.entries(SHIFTS)) await write(label, { shifts });

        appKey = await browserKey();

        // the records are indexed shortly after the write (the vectors a little later), and a new key reaches the edge shortly after its
        // issue: poll each mode until every record shows. A different limit per poll is a different cache key.
        const total = Object.keys(MOMENTS).length + Object.keys(SHIFTS).length;
        for (const mode of ['text', 'semantic', 'hybrid'] as const) {
            const deadline = Date.now() + 240_000;
            let seen = 0;
            for (let poll = 0; Date.now() < deadline; poll++) {
                const r = await search(appKey, { type: typeName, q: title, mode, limit: String(30 + (poll % 10)) });
                assertPreconditions(r);
                if (r.status === 200) seen = publicIds(r).length;
                if (seen >= total) break;
                await sleep(10_000);
            }
            if (seen < total) throw new Error(`only ${seen} of ${total} records are searchable in mode ${mode}`);
        }
    }, 900_000);

    // [name, public parameters, authenticated filters, the labels that must match]
    const day20 = { from: '2026-11-20T00:00:00.000Z', to: '2026-11-20T23:59:59.999Z' };
    const cases: Array<[string, Record<string, string>, Json, string[]]> = [
        ['an exact moment: the millisecond only', { startsAt: MOMENTS.D }, { startsAt: MOMENTS.D }, ['D']],
        ['an exact moment: the same second, another millisecond', { startsAt: MOMENTS.C }, { startsAt: MOMENTS.C }, ['C']],
        ['an exact moment: one millisecond off matches nothing', { startsAt: '2026-11-20T12:00:00.899Z' }, { startsAt: '2026-11-20T12:00:00.899Z' }, []],
        ['equal bounds at a sub-second moment', { 'startsAt.from': MOMENTS.D, 'startsAt.to': MOMENTS.D }, { startsAt: { $gte: MOMENTS.D, $lte: MOMENTS.D } }, ['D']],
        ['equal bounds at a whole second', { 'startsAt.from': MOMENTS.C, 'startsAt.to': MOMENTS.C }, { startsAt: { $gte: MOMENTS.C, $lte: MOMENTS.C } }, ['C']],
        ['an upper bound at a sub-second moment includes it', { 'startsAt.from': MOMENTS.C, 'startsAt.to': MOMENTS.D }, { startsAt: { $gte: MOMENTS.C, $lte: MOMENTS.D } }, ['C', 'D']],
        ['a lower bound at a sub-second moment excludes the second before it', { 'startsAt.from': '2026-11-20T12:00:00.001Z', 'startsAt.to': MOMENTS.E }, { startsAt: { $gte: '2026-11-20T12:00:00.001Z', $lte: MOMENTS.E } }, ['D', 'E']],
        ['a window inside one second that holds nothing', { 'startsAt.from': '2026-11-20T12:00:00.901Z', 'startsAt.to': '2026-11-20T12:00:00.999Z' }, { startsAt: { $gte: '2026-11-20T12:00:00.901Z', $lte: '2026-11-20T12:00:00.999Z' } }, []],
        ['a day: its first millisecond to its last', { 'startsAt.from': day20.from, 'startsAt.to': day20.to }, { startsAt: { $gte: day20.from, $lte: day20.to } }, ['A', 'B', 'C', 'D', 'E', 'F']],
        ['an upper bound at the next midnight includes that moment', { 'startsAt.from': day20.from, 'startsAt.to': MOMENTS.G }, { startsAt: { $gte: day20.from, $lte: MOMENTS.G } }, ['A', 'B', 'C', 'D', 'E', 'F', 'G']],
        ['a lower bound alone', { 'startsAt.from': MOMENTS.G }, { startsAt: { $gte: MOMENTS.G } }, ['G', 'MAX']],
        ['an upper bound alone', { 'startsAt.to': MOMENTS.H }, { startsAt: { $lte: MOMENTS.H } }, ['H', 'MIN']],
        ['the earliest storable moment', { 'startsAt.from': MOMENTS.MIN, 'startsAt.to': MOMENTS.MIN }, { startsAt: { $gte: MOMENTS.MIN, $lte: MOMENTS.MIN } }, ['MIN']],
        ['the latest storable moment', { 'startsAt.from': MOMENTS.MAX, 'startsAt.to': MOMENTS.MAX }, { startsAt: { $gte: MOMENTS.MAX, $lte: MOMENTS.MAX } }, ['MAX']],
        ['the whole span from the earliest to the latest moment', { 'startsAt.from': MOMENTS.MIN, 'startsAt.to': MOMENTS.MAX }, { startsAt: { $gte: MOMENTS.MIN, $lte: MOMENTS.MAX } }, Object.keys(MOMENTS)],
        ['a range past every record matches nothing', { 'startsAt.from': '2026-11-21T00:00:00.001Z', 'startsAt.to': '2026-11-21T00:00:00.002Z' }, { startsAt: { $gte: '2026-11-21T00:00:00.001Z', $lte: '2026-11-21T00:00:00.002Z' } }, []],
        ['the earliest storable moment, exactly', { startsAt: MOMENTS.MIN }, { startsAt: MOMENTS.MIN }, ['MIN']],
        ['a set holding the earliest and a later moment', { 'startsAt.in': `${MOMENTS.MIN},${MOMENTS.C}` }, { startsAt: { $in: [MOMENTS.MIN, MOMENTS.C] } }, ['C', 'MIN']],
        ['a set of moments', { 'startsAt.in': `${MOMENTS.C},${MOMENTS.D}` }, { startsAt: { $in: [MOMENTS.C, MOMENTS.D] } }, ['C', 'D']],
        ['an array matches when any element matches', { shifts: '2026-11-20T12:00:00.000Z' }, { shifts: '2026-11-20T12:00:00.000Z' }, ['X']],
        ['a set on an array matches when any element is in it', { 'shifts.in': '2026-11-22T08:00:00.000Z,2026-11-25T12:00:00.000Z' }, { shifts: { $in: ['2026-11-22T08:00:00.000Z', '2026-11-25T12:00:00.000Z'] } }, ['X', 'Y']],
    ];

    // the expected labels are also computed from the moments, so a wrong table above cannot agree with a wrong engine by accident
    test('the expected labels agree with the moments they describe', () => {
        const inside = (lo: string, hi: string): string[] =>
            Object.keys(MOMENTS).filter((l) => ms(MOMENTS[l]) >= ms(lo) && ms(MOMENTS[l]) <= ms(hi)).sort();
        expect(inside(day20.from, day20.to)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
        expect(inside(MOMENTS.C, MOMENTS.D)).toEqual(['C', 'D']);
        expect(inside('2026-11-20T12:00:00.001Z', MOMENTS.E)).toEqual(['D', 'E']);
        expect(inside('2026-11-20T12:00:00.901Z', '2026-11-20T12:00:00.999Z')).toEqual([]);
        expect(inside(MOMENTS.MIN, MOMENTS.MAX)).toEqual(Object.keys(MOMENTS).sort());
    });

    test.each(cases)('%s: the same answer in text, semantic and hybrid, and from the authenticated search', async (name, params, filters, expected) => {
        const want = [...expected].sort();
        for (const mode of ['text', 'semantic', 'hybrid'] as const) {
            expect(await publicLabels(params, mode)).toEqual(want);
        }
        // the oracle: the authenticated route, over the same index. Text for every case; the other two modes for the cases at a boundary,
        // so the authenticated tenant's own rate limit is not spent on 60 more searches
        const boundary = name.startsWith('an exact moment') || name.startsWith('an upper bound') || name.startsWith('a lower bound')
            || name.startsWith('a window') || name.startsWith('a day');
        for (const mode of boundary ? (['TEXT', 'SEMANTIC', 'HYBRID'] as const) : (['TEXT'] as const)) {
            expect(await authenticatedLabels(filters, mode)).toEqual(want);
        }
    }, 300_000);

    test.each([cases[0], cases[1], cases[5], cases[6], cases[8], cases[9]])(
        '%s: with no q, the filters alone give the same answer', async (_name, params, _filters, expected) => {
            expect(await publicLabels(params, 'filters-only')).toEqual([...expected].sort());
        }, 120_000);

    test('a set not in ascending order, or with a repeat, is refused', async () => {
        for (const value of [`${MOMENTS.D},${MOMENTS.C}`, `${MOMENTS.C},${MOMENTS.C}`]) {
            const r = await search(appKey, { type: typeName, q: title, mode: 'text', 'filter.startsAt.in': value });
            expectStatus(r, 400);
            expect(r.body.errorCode).toBe('PUBLIC_SEARCH_FILTER_NOT_ALLOWED');
        }
    }, 60_000);

    test('every other spelling of a moment is refused, in an exact filter, a range bound and a set', async () => {
        const spellings = ['2026-11-20', '2026-11-20T12:00:00Z', '2026-11-20T13:00:00.000+01:00', '2026-11-20T12:00:00.0001Z', '1795262400000'];
        for (const value of spellings) {
            for (const param of ['filter.startsAt', 'filter.startsAt.from', 'filter.startsAt.to', 'filter.startsAt.in', 'filter.shifts']) {
                const r = await search(appKey, { type: typeName, q: title, mode: 'text', [param]: value });
                expectStatus(r, 400);
                expect(r.body.errorCode).toBe('PUBLIC_SEARCH_FILTER_NOT_ALLOWED');
            }
        }
    }, 240_000);

    test('a range with its lower bound after its upper bound, and a range on an array, are refused', async () => {
        const backwards = await search(appKey, { type: typeName, q: title, mode: 'text', 'filter.startsAt.from': MOMENTS.D, 'filter.startsAt.to': MOMENTS.C });
        expectStatus(backwards, 400);
        const onArray = await search(appKey, { type: typeName, q: title, mode: 'text', 'filter.shifts.from': MOMENTS.C });
        expectStatus(onArray, 400);
        expect(onArray.body.errorCode).toBe('PUBLIC_SEARCH_FILTER_NOT_ALLOWED');
    }, 60_000);
});
