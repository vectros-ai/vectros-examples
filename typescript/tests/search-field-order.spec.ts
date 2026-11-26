/**
 * search-field-order.spec.ts — ordering search results by a field: `sortBy` with a field id, and `order`.
 *
 * Writes a few records of one type with a `date` field (`startsAt`) and a `number` field (`rate`), one of them with no
 * `startsAt`, then checks:
 *   1. with no query, the type's records come in `startsAt` order, ascending and descending, and the record without a
 *      value comes LAST in both directions;
 *   2. a `TEXT` query ordered by a `number` field, both directions;
 *   3. paging follows the order (`hasMore`, then the next page);
 *   4. the request rules: a field order is a 400 with a `HYBRID` query, with an `order` other than `asc`/`desc`, and
 *      without `typeName`; and, for a key limited to one app context, on a field that is not a sortable `number` or
 *      `date` field of the type.
 *
 * Things this shows that are not guessable from the signature: `query` is optional with a field `sortBy` (the search runs
 * on the keyword index, billed as `TEXT`), and an item with no value for the field never comes first, whichever the
 * direction.
 *
 * Writes: one schema and four records, all deleted at the end (a failed cleanup is logged and leaves them behind), and
 * mints one short-lived token for the `default` context that can search and read records (`search:r` and `records:r`).
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, tryCleanup } from '../src/helpers';

interface Hit { documentId?: string }
interface OrderedResponse { results?: Hit[]; hasMore?: boolean; incompleteResults?: boolean }

// `order` is newer than some SDK versions this suite may run against, so the body is typed loosely: the spec states the
// wire contract it checks.
async function search(body: Record<string, unknown>, c = client): Promise<OrderedResponse> {
    return (await c.search.content(body as unknown as Parameters<typeof client.search.content>[0])) as OrderedResponse;
}

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
    try {
        await p;
        return 200;
    } catch (e) {
        return (e as { statusCode?: number }).statusCode;
    }
}

const ids = (r: OrderedResponse) => (r.results ?? []).map((h) => h.documentId);

describe('search ordered by a field (sortBy + order)', () => {
    let schemaId: string;
    let typeName: string;
    const marker = `order_${uniqueTag()}`.replace(/-/g, '_');
    const rec: Record<string, string> = {};

    beforeAll(async () => {
        typeName = `smoke_shift_${uniqueTag()}`.replace(/-/g, '_');
        const schema = await client.schemas.createSchema({ body: {
            typeName,
            displayName: 'Smoke Shift (field order)',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'label', fieldType: 'string', required: false, searchable: true, filterable: true },
                { fieldId: 'startsAt', fieldType: 'date', required: false, filterable: true },
                { fieldId: 'rate', fieldType: 'number', required: false, filterable: true },
            ],
        } as unknown as Parameters<typeof client.schemas.createSchema>[0]['body'] });
        schemaId = schema.id!;
        const rows: Array<[string, string | undefined, number]> = [
            ['first', '2030-01-01', 30],
            ['third', '2030-01-03', 10],
            ['second', '2030-01-02', 20],
            ['unscheduled', undefined, 40],
        ];
        for (const [key, startsAt, rate] of rows) {
            const payload: Record<string, unknown> = { label: `${marker} ${key} shift`, rate };
            if (startsAt) payload.startsAt = startsAt;
            const r = await client.records.createRecord({ body: { typeName, schemaId, payload } });
            rec[key] = r.id!;
        }
        for (const id of Object.values(rec)) await pollUntilIndexed(id, 'record');
    });

    afterAll(async () => {
        for (const id of Object.values(rec)) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        if (schemaId) await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('no query: ascending by a date field, an item with no value last', async () => {
        const res = await search({ typeName, sortBy: 'startsAt', order: 'asc', limit: 10 });
        expect(ids(res)).toEqual([rec.first, rec.second, rec.third, rec.unscheduled]);
        // the API sends the nullable flag as null (or omits it); only true means a partial result
        expect(res.incompleteResults ?? undefined).toBeUndefined();
        expect(res.hasMore).toBe(false);
    });

    test('no query: descending, the item with no value still last', async () => {
        const res = await search({ typeName, sortBy: 'startsAt', order: 'desc', limit: 10 });
        expect(ids(res)).toEqual([rec.third, rec.second, rec.first, rec.unscheduled]);
    });

    test('a TEXT query ordered by a number field (order defaults to asc)', async () => {
        const res = await search({ query: marker, mode: 'TEXT', typeName, sortBy: 'rate', limit: 10 });
        expect(ids(res)).toEqual([rec.third, rec.second, rec.first, rec.unscheduled]);
    });

    test('a TEXT query ordered by a number field, descending', async () => {
        const res = await search({ query: marker, mode: 'TEXT', typeName, sortBy: 'rate', order: 'desc', limit: 10 });
        expect(ids(res)).toEqual([rec.unscheduled, rec.first, rec.second, rec.third]);
    });

    test('paging follows the order', async () => {
        const page1 = await search({ typeName, sortBy: 'startsAt', limit: 2, offset: 0 });
        expect(ids(page1)).toEqual([rec.first, rec.second]);
        expect(page1.hasMore).toBe(true);
        const page2 = await search({ typeName, sortBy: 'startsAt', limit: 2, offset: 2 });
        expect(ids(page2)).toEqual([rec.third, rec.unscheduled]);
        expect(page2.hasMore).toBe(false);
    });

    test('the request rules', async () => {
        expect(await statusOf(search({ query: marker, mode: 'HYBRID', typeName, sortBy: 'startsAt' }))).toBe(400);
        expect(await statusOf(search({ typeName, sortBy: 'startsAt', order: 'up' }))).toBe(400);
        expect(await statusOf(search({ sortBy: 'startsAt' }))).toBe(400);
        expect(await statusOf(search({ typeName, sortBy: 'distance', order: 'desc',
            filters: { place: { $near: { lat: 0, lon: 0, radiusMeters: 10 } } } }))).toBe(400);
        // A key limited to one app context gets a 400 for a field that is not a sortable number or date field of the type.
        // A token minted for `default` (where this suite's root key wrote the schema) is such a key.
        const minted = (await client.auth.mintToken({
            contextId: 'default', scope: { allowedActions: ['search:r', 'records:r'] },
        })) as { token: string };
        const confined = getScopedClient(minted.token);
        expect(await statusOf(search({ typeName, sortBy: 'label' }, confined))).toBe(400);
        expect(await statusOf(search({ typeName, sortBy: 'noSuchField' }, confined))).toBe(400);
        const ok = await search({ typeName, sortBy: 'startsAt' }, confined);
        expect(ids(ok)[0]).toBe(rec.first);
    });
});
