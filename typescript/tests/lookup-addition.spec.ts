/**
 * lookup-addition.spec.ts — adding a lookup to a type that already has records, live.
 *
 * A lookup declared on a type that already holds records does not reach back: a record written before the lookup existed is found
 * by it only after its next write. This spec runs that path end to end on the account of the API key:
 *
 *   1. it creates a type with one lookup (`state`) and writes a record carrying a value for a second field (`orgRef`);
 *   2. it adds a lookup on `orgRef` to the type (`PUT /v1/schemas/{id}` with the full `lookupFields` list);
 *   3. an exact lookup by `orgRef` does NOT return the record written before the lookup existed;
 *   4. a record written after the addition IS returned;
 *   5. once the first record is updated (any change), it IS returned too.
 *
 * Lookups read the store directly, so no step waits for indexing.
 *
 * The records and the type are removed when the spec ends.
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

function parse(text: string): Json {
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function call(method: string, path: string, body?: Json): Promise<Reply> {
    const key = process.env.VECTROS_API_KEY;
    if (!key) throw new Error('VECTROS_API_KEY required');
    const resp = await rateLimitAwareFetch(`${baseUrl()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: resp.status, body: parse(await resp.text()) };
}

function expectStatus(r: Reply, status: number): void {
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}

async function removed(r: Promise<Reply>): Promise<Reply> {
    const reply = await r;
    if (reply.status >= 300 && reply.status !== 404) throw new Error(`cleanup answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    return reply;
}

describe('lookups: adding one to a type that already has records', () => {
    let schemaId: string | undefined;
    const recordIds: string[] = [];
    afterAll(async () => {
        for (const id of recordIds) await tryCleanup('record', () => removed(call('DELETE', `/v1/records/${id}`)));
        if (schemaId) await tryCleanup('schema', () => removed(call('DELETE', `/v1/schemas/${schemaId}`)));
    });

    test('finds a record written before the lookup only after its next write', async () => {
        const tag = uniqueTag().replace(/[^a-z0-9]/gi, '').toLowerCase();
        const typeName = `smoke_lookupadd_${tag}`;
        const type = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Lookup addition probe', indexMode: 'NONE', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string' },
                { fieldId: 'state', fieldType: 'string' },
                { fieldId: 'orgRef', fieldType: 'string' },
            ],
            lookupFields: [{ fieldName: 'state' }],
        });
        expectStatus(type, 201);
        schemaId = type.body.id as string;

        const orgRef = `org${tag}`;
        const write = async (title: string): Promise<string> => {
            const r = await call('POST', '/v1/records', { typeName, schemaId, payload: { title, state: 'open', orgRef } });
            expectStatus(r, 201);
            recordIds.push(r.body.id as string);
            return r.body.id as string;
        };
        const lookup = async (): Promise<string[]> => {
            const q = new URLSearchParams({ type: typeName, field: 'orgRef', value: orgRef });
            const r = await call('GET', `/v1/records/lookup?${q.toString()}`);
            expectStatus(r, 200);
            return ((r.body.data ?? []) as Json[]).map((x) => x.id as string);
        };

        const before = await write('Written before the lookup');

        const added = await call('PUT', `/v1/schemas/${schemaId}`, { lookupFields: [{ fieldName: 'state' }, { fieldName: 'orgRef' }] });
        expectStatus(added, 200);
        expect(((added.body.lookupFields ?? []) as Array<Json | string>).map((l) => (typeof l === 'string' ? l : l.fieldName))).toEqual(['state', 'orgRef']);

        expect(await lookup()).not.toContain(before);

        const after = await write('Written after the lookup');
        expect(await lookup()).toContain(after);
        expect(await lookup()).not.toContain(before);

        const updated = await call('PUT', `/v1/records/${before}`, {
            typeName, schemaId, payload: { title: 'Written before the lookup (edited)', state: 'open', orgRef },
        });
        expectStatus(updated, 200);
        const now = await lookup();
        expect(now).toContain(before);
        expect(now).toContain(after);
    }, 120_000);
});
