/**
 * public-view-geo-precision.spec.ts — a geo field on a public projection copy, at its declared precision.
 *
 * A `projection` public view may list a `geo` field, and must then declare how precisely it is public in
 * `publicView.geoPrecision`: `"exact"` (the location as stored) or a cell size in metres (the public copy holds only the
 * centre of the grid cell, at least that size, that contains the location). This spec checks what an owner can observe with
 * their own key through `GET /v1/records/{id}/public-view`:
 *
 *   1. `"exact"`: the public view carries the stored point unchanged;
 *   2. a 1000 m grid: the public view carries a point that is NOT the stored one, lies within the cell (well under 1.5 km of
 *      it here), and the record itself still holds the exact point;
 *   3. a listed geo field with no precision is refused with `PUBLIC_VIEW_GEO_PRECISION_REQUIRED`, and a value outside the
 *      domain with `PUBLIC_VIEW_GEO_PRECISION_INVALID`.
 *
 * OPT-IN (GEO_SEARCH_CHECK=1), like the other geo checks: geo fields are turned on per tenant, so the default suite leaves this
 * spec out. The key is `VECTROS_RUN_SMOKE_API_KEY` when set (the account whose owner turned public access on), otherwise `VECTROS_API_KEY`. When it is opted in, BOTH preconditions must hold on the SAME account that key belongs to: public access is turned
 * on (the account owner's own setting), and geo fields are on for that key's tenant, which an owner of the account turns on by
 * signing the Geocoding waiver in the developer portal. Without either, the schema write is refused and this spec FAILS naming the one that is missing, rather
 * than skipping: a skipped opted-in run is not evidence.
 *
 * The routes are called over HTTP directly, so the spec does not depend on an SDK release that has the new key.
 */
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { uniqueTag, tryCleanup } from '../src/helpers';

type Json = Record<string, any>;
interface Reply { status: number; body: Json }

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

/** The key of the account that has public access on: `VECTROS_RUN_SMOKE_API_KEY` when set, otherwise `VECTROS_API_KEY`. */
function apiKey(): string {
    const key = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
    if (!key) throw new Error('VECTROS_API_KEY (or VECTROS_RUN_SMOKE_API_KEY) required');
    return key;
}

async function call(method: string, path: string, body?: Json): Promise<Reply> {
    const key = apiKey();
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

/** Great-circle distance in metres. */
function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const r = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
}

const POINT = { lat: 51.500729, lon: -0.124625 };

function body(typeName: string, geoPrecision?: Json): Json {
    return {
        typeName, displayName: 'Geo precision probe', indexMode: 'NONE', allowedSurfaces: ['record'],
        fields: [
            { fieldId: 'title', fieldType: 'string' },
            { fieldId: 'location', fieldType: 'geo' },
        ],
        publicView: {
            mode: 'projection', ownedBy: ['scope:org'], fields: ['title', 'location'],
            ...(geoPrecision === undefined ? {} : { geoPrecision }),
        },
    };
}

/** Fails with the unmet precondition, when the reply is one, rather than with a confusing status mismatch. */
function assertPreconditions(r: Reply): void {
    if (r.status === 409 && r.body.errorCode === 'PUBLIC_ACCESS_NOT_ENABLED') {
        throw new Error('PRECONDITION: public access is not turned on for this account; the account owner must enable it before this spec can run.');
    }
    if (r.status === 400 && /is off for this tenant/.test(JSON.stringify(r.body))) {
        throw new Error('PRECONDITION: geo fields are off for this tenant; an owner of the account must sign the Geocoding waiver for it in the developer portal before this spec can run.');
    }
}

async function createType(precision: string | number): Promise<{ typeName: string; schemaId: string }> {
    const typeName = `smoke_pvgeo_${uniqueTag()}`;
    const r = await call('POST', '/v1/schemas', body(typeName, { location: precision }));
    assertPreconditions(r);
    expectStatus(r, 201);
    expect(r.body.publicView.geoPrecision).toEqual({ location: precision });
    return { typeName, schemaId: r.body.id };
}

const geoOptIn = process.env.GEO_SEARCH_CHECK === '1';

(geoOptIn ? describe : describe.skip)('public views: a geo field at its declared precision', () => {
    const schemasToRemove: string[] = [];
    const orgsToRemove: string[] = [];
    afterAll(async () => {
        for (const id of schemasToRemove) await tryCleanup('schema', () => call('DELETE', `/v1/schemas/${id}`));
        for (const id of orgsToRemove) await tryCleanup('org', () => call('DELETE', `/v1/entities/org/${id}`));
    });

    async function publish(precision: string | number): Promise<{ id: string; view: Json }> {
        // created with the SAME key as the type and the record: an entity of another account cannot own the record's scope
        const orgReply = await call('POST', '/v1/entities/org', { externalId: 'pvgeo-org-' + uniqueTag(), name: 'Geo Precision Org' });
        expectStatus(orgReply, 201);
        const org = { id: orgReply.body.id as string };
        orgsToRemove.push(org.id);
        const { typeName, schemaId } = await createType(precision);
        schemasToRemove.push(schemaId);
        const created = await call('POST', '/v1/records', {
            typeName, schemaId, scopes: [`org:${org.id}`], payload: { title: 'Food bank', location: POINT },
        });
        expectStatus(created, 201);
        const id = created.body.id as string;
        const view = await call('GET', `/v1/records/${id}/public-view`);
        expectStatus(view, 200);
        return { id, view: view.body };
    }

    test('"exact" publishes the location as stored', async () => {
        const { id, view } = await publish('exact');
        try {
            expect(view.published).toBe(true);
            expect(view.fields.location).toEqual(POINT);
            expect(view.geoPrecision).toEqual({ location: 'exact' });
        } finally {
            await tryCleanup('record', () => call('DELETE', `/v1/records/${id}`));
        }
    }, 120_000);

    test('a 1000 m grid publishes only the cell centre; the record keeps the exact location', async () => {
        const { id, view } = await publish(1000);
        try {
            expect(view.published).toBe(true);
            expect(view.geoPrecision).toEqual({ location: 1000 });
            const shown = view.fields.location as { lat: number; lon: number };
            // the centre of the 1000 m cell that holds POINT (the grid is deterministic, so the value is fixed)
            expect(shown).toEqual({ lat: 51.4994483, lon: -0.1298857 });
            expect(metresBetween(shown, POINT)).toBeLessThan(1500);
            expect(JSON.stringify(view)).not.toContain('51.500729');
            expect(JSON.stringify(view)).not.toContain('0.124625');
            const own = await call('GET', `/v1/records/${id}`);
            expectStatus(own, 200);
            expect(own.body.payload.location).toEqual(POINT);
        } finally {
            await tryCleanup('record', () => call('DELETE', `/v1/records/${id}`));
        }
    }, 120_000);

    test('a listed geo field needs a precision, from the documented domain', async () => {
        const missing = await call('POST', '/v1/schemas', body(`smoke_pvgeo_${uniqueTag()}`));
        assertPreconditions(missing);
        expectStatus(missing, 400);
        expect(missing.body.errorCode).toBe('PUBLIC_VIEW_GEO_PRECISION_REQUIRED');
        const invalid = await call('POST', '/v1/schemas', body(`smoke_pvgeo_${uniqueTag()}`, { location: 50 }));
        expectStatus(invalid, 400);
        expect(invalid.body.errorCode).toBe('PUBLIC_VIEW_GEO_PRECISION_INVALID');
    }, 60_000);
});
