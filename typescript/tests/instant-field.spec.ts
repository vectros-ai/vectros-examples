/**
 * instant-field.spec.ts — the `instant` field type: one moment in time.
 *
 * What this shows, against a live deployment:
 *
 *   1. A value is sent as an RFC 3339 date-time WITH an offset, in any offset,
 *      and is stored and returned in UTC with millisecond precision
 *      (`YYYY-MM-DDTHH:MM:SS.sssZ`, the `Date.prototype.toISOString()` form).
 *   2. A value without an offset names no moment and is refused with a 400.
 *   3. An equality lookup matches the same moment whatever offset the query
 *      uses (or epoch milliseconds).
 *   4. A `rangeEnabled` lookup orders by time, with bounds in any offset.
 *   5. A search filter on an `instant` (or `date`) field compares by time, in
 *      TEXT and SEMANTIC modes alike: an ISO-8601 operand is converted to the
 *      stored moment before it reaches the index.
 *   6. A lookup field cannot be changed to or from `instant`, and schemas of one
 *      name (a base and its `basedOn` variants) must agree on the type of a
 *      field they both use in a lookup, whichever of them is saved second.
 *   7. Range lookups include both bounds, ties in different offsets are one
 *      moment, and paging one item at a time returns each record exactly once.
 *   8. A plain field can be changed to `instant`; a record holding an older
 *      value must then be rewritten before any other change to it is saved.
 *   9. A unique lookup refuses a second spelling of the same moment on create,
 *      update and batch; a composite lookup matches an instant leg in any offset.
 *  10. A published record's public view returns the stored (UTC) form.
 *  11. An `array` field with `itemType: instant` stores each element in UTC, refuses
 *      an element without an offset, and a search filter in ISO form matches a
 *      record when ANY element matches.
 */
import { client } from '../src/client';
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import {
    uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup, drainCursor, collectStream, withRateLimitRetry,
} from '../src/helpers';

// `instant` is newer than some published SDK versions' fieldType union; the
// wire accepts it either way, so the literal is widened for older clients.
const INSTANT = 'instant' as unknown as 'date';

async function captureStatus(p: Promise<unknown>): Promise<number | undefined> {
    try {
        await p;
        return undefined;
    } catch (e) {
        const err = e as { statusCode?: number };
        if (err.statusCode === undefined) throw e;
        return err.statusCode;
    }
}

describe('instant field type', () => {
    const marker = `instantsmoke${uniqueTag()}`;
    let recordType: string;
    let schemaId: string;
    let early: string;   // 2027-01-06T13:00:00.000Z
    let late: string;    // 2027-01-06T14:00:00.000Z
    let after: string;   // 2027-01-06T20:00:00.000Z
    const startedAt = new Date().toISOString();

    beforeAll(async () => {
        recordType = `smoke_shift_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Test Shift (instant)',
            indexMode: 'HYBRID',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true, searchable: true },
                { fieldId: 'decidedAt', fieldType: INSTANT, filterable: true },
                { fieldId: 'nextShiftAt', fieldType: INSTANT },
                { fieldId: 'startsOn', fieldType: 'date', filterable: true },
            ],
            lookupFields: [
                { fieldName: 'decidedAt', rangeEnabled: true },
                { fieldName: 'nextShiftAt' },
            ],
        } });
        schemaId = schema.id!;

        const create = (decidedAt: string, nextShiftAt: string, startsOn: string) =>
            client.records.createRecord({ body: {
                typeName: recordType,
                schemaId,
                payload: { title: `${marker} shift`, decidedAt, nextShiftAt, startsOn },
            } });
        early = (await create('2027-01-06T08:00:00-05:00', '2027-01-07T09:00:00+01:00', '2027-01-06')).id!;
        late = (await create('2027-01-06T15:00:00+01:00', '2027-01-08T08:00:00Z', '2027-01-07')).id!;
        after = (await create('2027-01-06T20:00:00Z', '2027-01-09T08:00:00Z', '2027-01-08')).id!;
        for (const id of [early, late, after]) await pollUntilIndexed(id, 'record');
        await pollUntilSearchable(marker, after, 60_000, 'TEXT', startedAt);
        await pollUntilSearchable(marker, after, 90_000, 'SEMANTIC', startedAt);
    }, 240_000);

    afterAll(async () => {
        for (const id of [early, late, after]) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('a value in any offset is stored and returned in UTC with milliseconds', async () => {
        const got = await client.records.getRecord({ id: early });
        expect(got.payload?.decidedAt).toBe('2027-01-06T13:00:00.000Z');
        expect(got.payload?.nextShiftAt).toBe('2027-01-07T08:00:00.000Z');
    });

    test('a value without an offset is refused', async () => {
        const status = await captureStatus(client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { title: `${marker} bad`, decidedAt: '2027-01-06T13:00:00' },
        } }));
        expect(status).toBe(400);
    });

    test('an equality lookup matches the same moment in any spelling', async () => {
        for (const value of ['2027-01-07T08:00:00Z', '2027-01-07T03:00:00-05:00', '1799308800000']) {
            const res = await client.records.lookupRecords({ type: recordType, field: 'nextShiftAt', value });
            expect((res.data ?? []).map((r) => r.id)).toEqual([early]);
        }
    });

    test('a range lookup orders by time, with bounds in any offset', async () => {
        const res = await client.records.lookupRecords({
            type: recordType,
            field: 'decidedAt',
            from: '2027-01-06T14:00:00+01:00',   // 13:00Z
            to: '2027-01-06T09:00:00-05:00',     // 14:00Z
        });
        expect((res.data ?? []).map((r) => r.id)).toEqual([early, late]);
    });

    test.each([
        ['a date alone', '2027-01-06'],
        ['a JSON number', 1799240400000],
        ['more precise than a millisecond', '2027-01-06T13:00:00.0001Z'],
        ['a year outside 0001-9999 in UTC', '0001-01-01T00:30:00+01:00'],
        ['a blank string', ''],
    ] as const)('a value that is %s is refused', async (_label, decidedAt) => {
        const status = await captureStatus(client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { title: `${marker} bad`, decidedAt },
        } }));
        expect(status).toBe(400);
    });

    test('an equality lookup one millisecond away finds nothing', async () => {
        const res = await client.records.lookupRecords({ type: recordType, field: 'nextShiftAt', value: '2027-01-07T08:00:00.001Z' });
        expect(res.data ?? []).toEqual([]);
    });

    test('search filters compare instants by time with $in, $ne, $nin and epoch milliseconds', async () => {
        const ids = async (filters: Record<string, unknown>) => {
            const res = await client.search.content({
                query: marker, mode: 'TEXT', limit: 100, createdAfter: startedAt, typeName: recordType,
                filters: filters as any,
            });
            return (res.results ?? []).map((r) => r.documentId);
        };
        // negative control: the unfiltered query finds all three, an operand past them all finds none
        expect(await ids({})).toEqual(expect.arrayContaining([early, late, after]));
        const none = await ids({ decidedAt: { $gt: '2027-01-06T21:00:00+01:00' } });
        for (const id of [early, late, after]) expect(none).not.toContain(id);

        const inSet = await ids({ decidedAt: { $in: ['2027-01-06T08:00:00-05:00', '2027-01-06T20:00:00.000Z'] } });
        expect(inSet).toEqual(expect.arrayContaining([early, after]));
        expect(inSet).not.toContain(late);

        const notEqual = await ids({ decidedAt: { $ne: '2027-01-06T14:00:00+01:00' } });
        expect(notEqual).toEqual(expect.arrayContaining([late, after]));
        expect(notEqual).not.toContain(early);

        const notIn = await ids({ decidedAt: { $nin: ['2027-01-06T13:00:00Z', '2027-01-06T09:00:00-05:00'] } });
        expect(notIn).toContain(after);
        expect(notIn).not.toContain(early);
        expect(notIn).not.toContain(late);

        const byEpoch = await ids({ decidedAt: { $gte: '1799265600000' } });   // 2027-01-06T20:00:00Z
        expect(byEpoch).toContain(after);
        expect(byEpoch).not.toContain(early);
        expect(byEpoch).not.toContain(late);
    }, 60_000);

    test('a RAG search filter in ISO form compares instants by time', async () => {
        const stream = await withRateLimitRetry(() => client.inference.ragInference({
            query: `${marker} shift`,
            search: {
                mode: 'TEXT', limit: 20, createdAfter: startedAt, typeName: recordType,
                filters: { decidedAt: { $gte: '2027-01-06T09:00:00-05:00' } } as any,   // 14:00Z
            },
            maxTokens: 256,
        }));
        const events = await collectStream<any>(stream);
        const results = events.find((e) => e.event === 'search_results');
        expect(results).toBeDefined();
        const ids = (results.results as Array<{ documentId: string }>).map((r) => r.documentId);
        expect(ids).toEqual(expect.arrayContaining([late, after]));
        expect(ids).not.toContain(early);
    }, 120_000);

    test.each(['TEXT', 'SEMANTIC'] as const)(
        'a search range filter in ISO form compares instants and dates by time (%s)', async (mode) => {
            const byInstant = await client.search.content({
                query: marker, mode, limit: 100, createdAfter: startedAt, typeName: recordType,
                filters: { decidedAt: { $gte: '2027-01-06T14:00:00+01:00', $lt: '2027-01-06T14:00:00.001Z' } },
            });
            const instantIds = (byInstant.results ?? []).map((r) => r.documentId);
            expect(instantIds).toEqual(expect.arrayContaining([early, late]));
            expect(instantIds).not.toContain(after);

            const byDate = await client.search.content({
                query: marker, mode, limit: 100, createdAfter: startedAt, typeName: recordType,
                filters: { startsOn: { $gte: '2027-01-07' } },
            });
            const dateIds = (byDate.results ?? []).map((r) => r.documentId);
            expect(dateIds).toEqual(expect.arrayContaining([late, after]));
            expect(dateIds).not.toContain(early);
        }, 60_000);

    test('a lookup field cannot be changed to or from instant', async () => {
        const current = await client.schemas.getSchema({ id: schemaId });
        const fields = (current.fields ?? []).map((f) =>
            f.fieldId === 'nextShiftAt' ? { ...f, fieldType: 'string' as const } : f);
        const status = await captureStatus(client.schemas.updateSchema({ id: schemaId, body: {
            typeName: recordType,
            displayName: current.displayName ?? 'Smoke Test Shift (instant)',
            indexMode: current.indexMode,
            allowedSurfaces: current.allowedSurfaces ?? ['record'],
            fields,
            lookupFields: current.lookupFields ?? [],
        } }));
        expect(status).toBe(400);
    });

    test('the type of a rangeEnabled lookup field is locked', async () => {
        const current = await client.schemas.getSchema({ id: schemaId });
        const fields = (current.fields ?? []).map((f) =>
            f.fieldId === 'decidedAt' ? { ...f, fieldType: 'date' as const } : f);
        const status = await captureStatus(client.schemas.updateSchema({ id: schemaId, body: {
            typeName: recordType,
            displayName: current.displayName ?? 'Smoke Test Shift (instant)',
            indexMode: current.indexMode,
            allowedSurfaces: current.allowedSurfaces ?? ['record'],
            fields,
            lookupFields: current.lookupFields ?? [],
        } }));
        expect(status).toBe(400);
    });

    test('schemas of one name must agree on the type of a field they both use in a lookup', async () => {
        const owner = await client.identity.createUser({ body: { externalId: `instant-owner-${uniqueTag()}` } });
        const created: string[] = [];
        try {
            // Variant saved second: the base uses `when` as an instant lookup, the variant as a string lookup.
            const typeA = `smoke_shift_lineage_${uniqueTag()}`;
            const baseA = await client.schemas.createSchema({ body: {
                typeName: typeA, displayName: 'Lineage base (instant)', indexMode: 'NONE', allowedSurfaces: ['record'],
                fields: [{ fieldId: 'when', fieldType: INSTANT }],
                lookupFields: [{ fieldName: 'when' }],
            } });
            created.push(baseA.id!);
            expect(await captureStatus(client.schemas.createSchema({ body: {
                typeName: typeA, displayName: 'Lineage variant (string)', indexMode: 'NONE', allowedSurfaces: ['record'],
                fields: [{ fieldId: 'when', fieldType: 'string' }],
                lookupFields: [{ fieldName: 'when' }],
                basedOn: baseA.id, userId: owner.id,
            } }))).toBe(400);

            // Base saved second: the variant already uses `when` as a date lookup.
            const typeB = `smoke_shift_lineage_${uniqueTag()}`;
            const baseB = await client.schemas.createSchema({ body: {
                typeName: typeB, displayName: 'Lineage base', indexMode: 'NONE', allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string' }],
            } });
            created.push(baseB.id!);
            const variantB = await client.schemas.createSchema({ body: {
                typeName: typeB, displayName: 'Lineage variant (date)', indexMode: 'NONE', allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string' }, { fieldId: 'when', fieldType: 'date' }],
                lookupFields: [{ fieldName: 'when' }],
                basedOn: baseB.id, userId: owner.id,
            } });
            created.unshift(variantB.id!);
            expect(await captureStatus(client.schemas.updateSchema({ id: baseB.id!, body: {
                typeName: typeB, displayName: 'Lineage base', indexMode: 'NONE', allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string' }, { fieldId: 'when', fieldType: INSTANT }],
                lookupFields: [{ fieldName: 'when' }],
            } }))).toBe(400);
        } finally {
            for (const id of created) {
                await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
            }
            await tryCleanup('delete owner user', () => client.identity.deleteUser({ id: owner.id! }));
        }
    });
});

describe('instant field type: ranges, ties and paging', () => {
    let recordType: string;
    let schemaId: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
        recordType = `smoke_tick_${uniqueTag()}`;
        schemaId = (await client.schemas.createSchema({ body: {
            typeName: recordType, displayName: 'Smoke Test Tick (instant)', indexMode: 'NONE', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'at', fieldType: INSTANT }],
            lookupFields: [{ fieldName: 'at', rangeEnabled: true }],
        } })).id!;
        const values: Record<string, string> = {
            first: '0001-01-01T00:00:00Z',
            tieA: '2027-03-01T10:00:00+02:00',   // the three ties are one moment: 08:00Z
            tieB: '2027-03-01T08:00:00Z',
            tieC: '2027-03-01T03:00:00-05:00',
            last: '9999-12-31T23:59:59.999Z',
        };
        for (const [name, at] of Object.entries(values)) {
            ids[name] = (await client.records.createRecord({ body: { typeName: recordType, schemaId, payload: { at } } })).id!;
        }
    }, 60_000);

    afterAll(async () => {
        for (const id of Object.values(ids)) await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('both bounds are inclusive, whatever offset spells them', async () => {
        const res = await client.records.lookupRecords({
            type: recordType, field: 'at', from: '2027-03-01T08:00:00Z', to: '2027-03-01T09:00:00+01:00',
        });
        expect((res.data ?? []).map((r) => r.id).sort()).toEqual([ids.tieA, ids.tieB, ids.tieC].sort());
        const past = await client.records.lookupRecords({
            type: recordType, field: 'at', from: '2027-03-01T08:00:00.001Z', to: '2027-03-01T09:00:00Z',
        });
        expect(past.data ?? []).toEqual([]);
    });

    test('paging one at a time through ties returns each record exactly once', async () => {
        const all = await drainCursor((startFrom) => client.records.lookupRecords({
            type: recordType, field: 'at', from: '2027-03-01T07:00:00Z', to: '2027-03-01T09:00:00Z', limit: 1, startFrom,
        }));
        const got = all.map((r) => r.id);
        expect(got.length).toBe(3);
        expect([...got].sort()).toEqual([ids.tieA, ids.tieB, ids.tieC].sort());
    });

    test('the earliest and latest storable instants order first and last', async () => {
        const all = await drainCursor((startFrom) => client.records.lookupRecords({
            type: recordType, field: 'at', from: '0001-01-01T00:00:00Z', to: '9999-12-31T23:59:59.999Z',
            order: 'asc', limit: 100, startFrom,
        }));
        const got = all.map((r) => r.id);
        expect(got.length).toBe(5);
        expect(got[0]).toBe(ids.first);
        expect(got[4]).toBe(ids.last);
    });
});

describe('instant field type: changing a field, uniqueness and composites', () => {
    let recordType: string;
    let schemaId: string;
    const created: string[] = [];

    const schemaBody = (noteType: string) => ({
        typeName: recordType, displayName: 'Smoke Test Slot (instant)', indexMode: 'NONE' as const, allowedSurfaces: ['record'],
        fields: [
            { fieldId: 'note', fieldType: noteType as 'string' },
            { fieldId: 'status', fieldType: 'string' as const },
            { fieldId: 'at', fieldType: INSTANT },
            { fieldId: 'code', fieldType: INSTANT },
        ],
        lookupFields: [{ fieldName: 'code', unique: true }, { fieldNames: ['status', 'at'] }],
    });
    const create = async (payload: Record<string, unknown>) => {
        const id = (await client.records.createRecord({ body: { typeName: recordType, schemaId, payload } })).id!;
        created.push(id);
        return id;
    };

    beforeAll(async () => {
        recordType = `smoke_slot_${uniqueTag()}`;
        schemaId = (await client.schemas.createSchema({ body: schemaBody('string') as any })).id!;
    });

    afterAll(async () => {
        for (const id of created) await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('a plain field changed to instant: an older value must be rewritten before the record is saved again', async () => {
        const id = await create({ note: 'next tuesday', status: 'draft' });
        await client.schemas.updateSchema({ id: schemaId, body: schemaBody(INSTANT) as any });

        expect(await captureStatus(client.records.patchRecord({ id, body: { payload: { status: 'open' } } }))).toBe(400);
        const fixed = await client.records.patchRecord({ id, body: { payload: { note: '2027-01-06T18:00:00+01:00' } } });
        expect(fixed.payload?.note).toBe('2027-01-06T17:00:00.000Z');
        const saved = await client.records.patchRecord({ id, body: { payload: { status: 'open' } } });
        expect(saved.payload?.status).toBe('open');
    });

    test('a unique instant refuses another spelling of the same moment on create, update and batch', async () => {
        await create({ code: '2027-01-06T17:00:00Z' });
        const dup = await captureStatus(client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { code: '2027-01-06T18:00:00+01:00' },
        } }));
        expect([400, 409]).toContain(dup);

        const other = await create({ code: '2027-01-06T19:00:00Z' });
        const upd = await captureStatus(client.records.patchRecord({ id: other, body: { payload: { code: '2027-01-06T12:00:00-05:00' } } }));
        expect([400, 409]).toContain(upd);

        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [
                { typeName: recordType, schemaId, payload: { code: '2027-02-01T09:00:00Z' } },
                { typeName: recordType, schemaId, payload: { code: '2027-02-01T10:00:00+01:00' } },
            ],
        } as any);
        for (const r of resp.results ?? []) if (r.id) created.push(r.id);
        expect(resp.succeeded).toBe(1);
        expect(resp.failed).toBe(1);
    });

    test('a composite lookup matches its instant leg in any offset', async () => {
        const id = await create({ status: 'booked', at: '2027-01-06T17:00:00Z' });
        const res = await client.records.lookupRecords({
            type: recordType, field: 'status,at', values: ['booked', '2027-01-06T12:00:00-05:00'],
        });
        expect((res.data ?? []).map((r) => r.id)).toEqual([id]);
    });
});

describe('instant field type: public view', () => {
    // Called over HTTP so the spec does not depend on an SDK release that has the public-view route.
    // PRECONDITION: public access is turned on for the key's account (as for public-view-projection.spec.ts).
    async function call(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
        const key = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
        const base = (process.env.VECTROS_API_BASE_URL ?? '').replace(/\/+$/, '');
        if (!key || !base) throw new Error('VECTROS_API_KEY and VECTROS_API_BASE_URL required');
        const resp = await rateLimitAwareFetch(`${base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await resp.text();
        let parsed: any = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        return { status: resp.status, body: parsed };
    }

    test('a published record shows its instant in the stored form', async () => {
        const org = await call('POST', '/v1/entities/org', { externalId: `instant-pv-${uniqueTag()}`, name: 'Instant public view org' });
        expect(org.status).toBe(201);
        const typeName = `smoke_pvinstant_${uniqueTag()}`;
        const schema = await call('POST', '/v1/schemas', {
            typeName, displayName: 'Instant public view probe', indexMode: 'NONE', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'startsAt', fieldType: 'instant' }],
            publicView: { mode: 'projection', ownedBy: ['scope:org'], fields: ['title', 'startsAt'] },
        });
        if (schema.status === 409 && schema.body.errorCode === 'PUBLIC_ACCESS_NOT_ENABLED') {
            throw new Error('PRECONDITION: public access is not turned on for this account; the account owner must enable it before this test can run.');
        }
        expect(schema.status).toBe(201);
        let recordId: string | undefined;
        try {
            const rec = await call('POST', '/v1/records', {
                typeName, schemaId: schema.body.id, scopes: [`org:${org.body.id}`],
                payload: { title: 'Opening', startsAt: '2027-01-06T18:00:00+01:00' },
            });
            expect(rec.status).toBe(201);
            recordId = rec.body.id;
            const view = await call('GET', `/v1/records/${recordId}/public-view`);
            expect(view.status).toBe(200);
            expect(view.body.fields).toEqual({ title: 'Opening', startsAt: '2027-01-06T17:00:00.000Z' });
        } finally {
            if (recordId) await tryCleanup('delete record', () => call('DELETE', `/v1/records/${recordId}`));
            await tryCleanup('delete schema', () => call('DELETE', `/v1/schemas/${schema.body.id}`));
            await tryCleanup('delete org', () => call('DELETE', `/v1/entities/org/${org.body.id}`));
        }
    }, 120_000);
});

describe('instant field type: an array of instants', () => {
    const marker = `instantarray${uniqueTag()}`;
    const startedAt = new Date().toISOString();
    let recordType: string;
    let schemaId: string;
    let early: string;
    let late: string;

    beforeAll(async () => {
        recordType = `smoke_course_${uniqueTag()}`;
        schemaId = (await client.schemas.createSchema({ body: {
            typeName: recordType, displayName: 'Smoke Test Course (instant array)', indexMode: 'HYBRID', allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true, searchable: true },
                // `itemType` is newer than some published SDK versions; the wire accepts it either way.
                { fieldId: 'sessions', fieldType: 'array', itemType: 'instant', filterable: true } as any,
            ],
        } })).id!;
        const create = async (sessions: string[]) => (await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { title: `${marker} course`, sessions },
        } })).id!;
        early = await create(['2027-01-06T08:00:00-05:00', '2027-01-07T09:00:00+01:00']);   // 13:00Z, 08:00Z next day
        late = await create(['2027-02-01T10:00:00+02:00']);                                 // 2027-02-01T08:00Z
        for (const id of [early, late]) await pollUntilIndexed(id, 'record');
        await pollUntilSearchable(marker, late, 60_000, 'TEXT', startedAt);
    }, 180_000);

    afterAll(async () => {
        for (const id of [early, late]) await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('each element is stored and returned in UTC with milliseconds', async () => {
        const got = await client.records.getRecord({ id: early });
        expect(got.payload?.sessions).toEqual(['2027-01-06T13:00:00.000Z', '2027-01-07T08:00:00.000Z']);
    });

    test('an element without an offset is refused', async () => {
        const status = await captureStatus(client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { title: `${marker} bad`, sessions: ['2027-01-06T13:00:00Z', '2027-01-06T13:00:00'] },
        } }));
        expect(status).toBe(400);
    });

    test('a search filter in ISO form matches a record when any element matches', async () => {
        const ids = async (filters: Record<string, unknown>) => ((await client.search.content({
            query: marker, mode: 'TEXT', limit: 100, createdAfter: startedAt, typeName: recordType, filters: filters as any,
        })).results ?? []).map((r) => r.documentId);
        // the second element of `early` (08:00Z on the 7th) is in range; no element of `late` is
        const hit = await ids({ sessions: { $gte: '2027-01-07T09:00:00+01:00', $lt: '2027-01-08T00:00:00Z' } });
        expect(hit).toContain(early);
        expect(hit).not.toContain(late);
        // negative control: an operand past every element finds neither
        const none = await ids({ sessions: { $gt: '2027-03-01T00:00:00Z' } });
        expect(none).not.toContain(early);
        expect(none).not.toContain(late);
        // one element equals it, in another offset
        expect(await ids({ sessions: '2027-02-01T03:00:00-05:00' })).toEqual([late]);
    }, 60_000);
});
