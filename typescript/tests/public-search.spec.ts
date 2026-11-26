/**
 * public-search.spec.ts — anonymous public search, live: `GET /v1/public/search` with a publishable key.
 *
 * A type whose public view offers `text` search can be searched by anyone holding one of its app context's publishable keys,
 * with no sign-in. This spec runs that path end to end, through the edge, on the account the key belongs to:
 *
 *   1. it creates a `projection` type (title, a filterable number `seats` and a filterable date `day` public, phone private) that offers `text` search, with `cacheSeconds: 0` so no
 *      answer is ever served from the edge cache, and publishes one record of it;
 *   2. it uses an ACTIVE browser key (`pub_...`) of the default app context when one exists, and issues one only when none does;
 *   3. an anonymous search with that key finds the record by a word in its title, and the hit carries only the public fields
 *      (never the private one, never the record id);
 *   4. a range filter (`filter.<field>.from` / `filter.<field>.to`, inclusive) on the public number field and on the public date
 *      field (a calendar day, `YYYY-MM-DD`, per bound; the record's date is 2027-01-09) keeps the
 *      record when its value is inside the range, at either bound, and drops it outside;
 *      a set filter (`filter.seats.in`) keeps it when its value is in the set and drops it otherwise, negative values included (a
 *      negative value in a set once matched every record in text mode);
 *   5. the same search with a forged key (the key with one character of its signature changed) is refused `403 PUBLIC_KEY_INVALID`.
 *
 * The type offers `text` search only, so the filters here run on the keyword index; the vector index is not exercised by this spec.
 *
 * The record, the type and the org are removed when the spec ends. A key the spec did not issue is never revoked. Revoking a key also
 * revokes EVERY older key of its app context, so a key the spec issued is revoked only when no older key of the context is still active
 * (checked again at cleanup); otherwise it is left active, and the next run reuses it.
 *
 * PRECONDITIONS, on the account of `VECTROS_RUN_SMOKE_API_KEY` (when set, otherwise `VECTROS_API_KEY`): public access is turned on
 * and a public budget is chosen (both the account owner's), and the account owner allows public `text` search. Each missing precondition
 * FAILS the spec, naming it, rather than skipping: a skipped run is not evidence.
 *
 * Each search that reaches the engine is charged as one public text search to the account.
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

/** An anonymous search: the publishable key in `k`, no other credential. */
async function search(appKey: string, typeName: string, q: string, filters: Record<string, string> = {}): Promise<Reply> {
    const query = new URLSearchParams({ k: appKey, type: typeName, q, mode: 'text', limit: '10' });
    for (const [name, value] of Object.entries(filters)) query.set(`filter.${name}`, value);
    const resp = await rateLimitAwareFetch(`${baseUrl()}/v1/public/search?${query.toString()}`, { headers: { Accept: 'application/json' } });
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
    if (code === 'PUBLIC_SEARCH_UNAVAILABLE') {
        throw new Error('PRECONDITION: the account owner does not allow public text search on this account; allow it before this spec can run.');
    }
}

/**
 * The key with one character of its SIGNATURE changed: still a well-formed key, so the refusal proves the signature check, not the shape
 * check. The 59 characters after the prefix encode 44 bytes, the last 16 the signature; character 40 lies inside it, and every character
 * there is a canonical spelling (only the LAST character carries spare bits).
 */
function forged(appKey: string): string {
    const at = appKey.indexOf('_') + 1 + 40;
    const c = appKey.charAt(at);
    return appKey.slice(0, at) + (c === 'A' ? 'B' : 'A') + appKey.slice(at + 1);
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

describe('public search: an anonymous search with a publishable key', () => {
    let schemaId: string | undefined;
    let recordId: string | undefined;
    let orgId: string | undefined;
    /** A key THIS spec issued (never one it found): the only key it may revoke. */
    let issued: KeyRow | undefined;
    afterAll(async () => {
        if (issued) {
            const mine = issued;
            await tryCleanup('publishable key', async () => {
                // revoking cascades to every OLDER key of the context: revoke only while no older key of it is active
                const older = (await allKeys()).filter((k) => activeDefault(k) && k.keyId !== mine.keyId && (k.version ?? 0) < (mine.version ?? 0));
                if (older.length > 0) return;   // left active: the next run reuses it
                await removed(call('DELETE', `/v1/admin/public-keys/${mine.keyId}`));
            });
        }
        if (recordId) await tryCleanup('record', () => removed(call('DELETE', `/v1/records/${recordId}`)));
        if (schemaId) await tryCleanup('schema', () => removed(call('DELETE', `/v1/schemas/${schemaId}`)));
        if (orgId) await tryCleanup('org', () => removed(call('DELETE', `/v1/entities/org/${orgId}`)));
    });

    test('finds a published record by a word in a public field, serves only public fields, and refuses a forged key', async () => {
        const orgReply = await call('POST', '/v1/entities/org', { externalId: 'pubsearch-org-' + uniqueTag(), name: 'Public Search Org' });
        expectStatus(orgReply, 201);
        orgId = orgReply.body.id as string;

        const typeName = `smoke_pubsearch_${uniqueTag()}`;
        const type = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Public search probe', indexMode: 'NONE', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string' },
                { fieldId: 'phone', fieldType: 'string' },
                { fieldId: 'seats', fieldType: 'number', filterable: true },
                { fieldId: 'day', fieldType: 'date', filterable: true },
            ],
            publicView: { mode: 'projection', ownedBy: ['scope:org'], fields: ['title', 'seats', 'day'], search: ['text'], cacheSeconds: 0 },
        });
        assertPreconditions(type);
        expectStatus(type, 201);
        schemaId = type.body.id as string;
        expect(type.body.publicView.search).toEqual(['text']);

        // a word no other record holds, so the hit can only be this record
        const word = `dunes${uniqueTag().replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
        const created = await call('POST', '/v1/records', {
            typeName, schemaId, scopes: [`org:${orgId}`], payload: { title: `Beach cleanup at the ${word}`, phone: '07700 900123', seats: 40, day: '2027-01-09' },
        });
        expectStatus(created, 201);
        recordId = created.body.id as string;
        const view = await call('GET', `/v1/records/${recordId}/public-view`);
        expectStatus(view, 200);
        expect(view.body.published).toBe(true);
        const publicId = view.body.publicId as string;

        // an active browser key of the default context when there is one (reused, never revoked); otherwise one issued for this run
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

        // the copy is indexed shortly after the write, and a new key reaches the edge shortly after its issue: poll until the hit shows
        let found: Reply = { status: 0, body: {} };
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            found = await search(appKey, typeName, word);
            assertPreconditions(found);
            if (found.status === 200 && (found.body.data ?? []).some((h: Json) => h.publicId === publicId)) break;
            await sleep(3000);
        }
        expectStatus(found, 200);
        const hit = (found.body.data as Json[]).find((h) => h.publicId === publicId);
        expect(hit).toBeDefined();
        expect(hit!.type).toBe(typeName);
        expect(hit!.fields).toMatchObject({ title: `Beach cleanup at the ${word}`, seats: 40 });
        expect(Object.keys(hit!.fields).sort()).toEqual(['day', 'seats', 'title']);
        expect(JSON.stringify(found.body)).not.toContain('07700');
        expect(JSON.stringify(found.body)).not.toContain(recordId);

        // range filters, inclusive at both ends, either bound alone; the record (seats 40) is already indexed, so no polling
        const holds = (r: Reply) => (r.body.data ?? []).some((h: Json) => h.publicId === publicId);
        const insides: Record<string, string>[] = [
            { 'seats.from': '30', 'seats.to': '50' }, { 'seats.from': '40', 'seats.to': '40' }, { 'seats.from': '40' }, { 'seats.to': '40' },
            { 'day.from': '2027-01-09', 'day.to': '2027-01-09' }, { 'day.from': '2027-01-01' }, { 'day.to': '2027-01-09' },
            { 'seats.from': '40', 'day.to': '2027-01-31' },
            { 'seats.in': '40' }, { 'seats.in': '12,40,60.5' }, { 'seats.in': '-2.5,40' }, { day: '2027-01-09' },
            { 'seats.from': '-5', 'seats.to': '40' }, { 'seats.from': '-5' },
        ];
        for (const inside of insides) {
            const r = await search(appKey, typeName, word, inside);
            expectStatus(r, 200);
            expect(holds(r)).toBe(true);
        }
        const outsides: Record<string, string>[] = [
            { 'seats.from': '41' }, { 'seats.to': '39.5' }, { 'seats.from': '10', 'seats.to': '20' },
            { 'day.from': '2027-01-10' }, { 'day.to': '2027-01-08' }, { 'seats.from': '40', 'day.from': '2027-02-01' },
            { 'seats.in': '12,41' }, { 'seats.in': '-2.5,12' }, { 'seats.in': '-7,-2.5' }, { day: '2027-01-10' },
            { 'seats.from': '-5', 'seats.to': '-1' }, { 'seats.to': '-1' },
        ];
        for (const outside of outsides) {
            const r = await search(appKey, typeName, word, outside);
            expectStatus(r, 200);
            expect(holds(r)).toBe(false);
        }
        const malformed = await search(appKey, typeName, word, { 'seats.from': '040' });
        expectStatus(malformed, 400);
        expect(malformed.body.errorCode).toBe('PUBLIC_SEARCH_FILTER_NOT_ALLOWED');
        const unordered = await search(appKey, typeName, word, { 'seats.in': '40,12' });
        expectStatus(unordered, 400);
        expect(unordered.body.errorCode).toBe('PUBLIC_SEARCH_FILTER_NOT_ALLOWED');

        const refused = await search(forged(appKey), typeName, word);
        expectStatus(refused, 403);
        expect(refused.body.errorCode).toBe('PUBLIC_KEY_INVALID');
        expect(JSON.stringify(refused.body)).not.toContain(word);
    }, 240_000);
});
