/**
 * composite-lookup.spec.ts — SDK 0.38.0's headline feature: a lookup declared
 * over SEVERAL fields at once (`fieldNames`, in place of the single-field
 * `fieldName`), queried with a comma-joined `field` plus the new `values`
 * parameter. This is the reference example for the feature — the fullest
 * one across all three language suites — so it covers both the GET and
 * POST-body query forms and the array-serialization edge case, not just the
 * headline behaviour.
 *
 * Things about this feature that are not guessable from the signature alone,
 * so this spec exists to show them concretely:
 *
 *   1. A FULLY specified tuple (one value per declared field) narrows to an
 *      exact match, same as any other lookup.
 *   2. A PARTIAL tuple (fewer values than the lookup declares — always a
 *      LEADING run of the declared fields) returns every record matching the
 *      values you gave, GROUPED by the field(s) you left unspecified.
 *      `sortBy` (createdAt by default) then orders records WITHIN each group,
 *      not across the whole result — there is no separate "group" field on
 *      the response; the grouping is expressed purely as adjacency in `data`.
 *   3. `values` is the API's first ARRAY-typed query parameter. Its
 *      correctness rests on the generated client sending a REPEATED
 *      `?values=a&values=b` (correct) rather than a comma-joined `?values=a,b`
 *      (which would silently corrupt any legal value containing a comma —
 *      indistinguishable from the caller having meant one more leg than they
 *      did). Verified here with a value that itself contains a comma; the
 *      Java example's `CompositeLookupSmokeTest` proves the same thing for
 *      that language's generated client.
 *   4. The POST body variant (`lookupRecordsByBody`) takes `values` as a
 *      plain array in the JSON body rather than a repeated query parameter,
 *      so it has no encoding ambiguity of its own — shown here for parity
 *      with the GET form.
 *   5. `sortFrom`/`sortTo` (also new in 0.38.0) narrow a lookup to a window of
 *      the sort key's own units — but only on a FULLY specified tuple, since
 *      the ordering is continuous only within one exact combination.
 */
import { client } from '../src/client';
import { uniqueTag, pollUntilIndexed, tryCleanup } from '../src/helpers';

describe('composite lookup (fieldNames + values)', () => {
    let recordType: string;
    let schemaId: string;
    // Three "open" tickets — two in the "billing" area (created a beat apart,
    // so createdAt orders them r1 then r3 within their group) and one in
    // "support" — plus one "closed" ticket that every query below must
    // exclude — plus a fifth whose area VALUE itself contains a comma, for
    // the array-serialization check.
    let r1open_billing: string;
    let r2open_support: string;
    let r3open_billing: string;
    let r4closed_billing: string;
    let r5open_commaArea: string;

    beforeAll(async () => {
        recordType = `smoke_ticket_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Test Ticket (composite lookup)',
            indexMode: 'TEXT',
            // A lookup over several fields cannot set `unique` or `rangeEnabled`,
            // and its schema must list `record` as its only allowedSurfaces entry.
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true, searchable: true },
                { fieldId: 'status', fieldType: 'string', required: true, filterable: true },
                { fieldId: 'area', fieldType: 'string', required: true, filterable: true },
            ],
            // Declare with `fieldNames` in place of `fieldName`. Order is
            // significant and fixed once declared — see the module doc.
            lookupFields: [{ fieldNames: ['status', 'area'] }],
        } });
        schemaId = schema.id!;

        const create = (title: string, status: string, area: string) =>
            client.records.createRecord({ body: {
                typeName: recordType,
                schemaId,
                payload: { title, status, area },
            } });

        const r1 = await create('cannot reach support line', 'open', 'billing');
        r1open_billing = r1.id!;
        const r2 = await create('feature request: dark mode', 'open', 'support');
        r2open_support = r2.id!;
        const r3 = await create('invoice shows wrong total', 'open', 'billing');
        r3open_billing = r3.id!;
        const r4 = await create('duplicate charge (resolved)', 'closed', 'billing');
        r4closed_billing = r4.id!;
        const r5 = await create('mis-tagged area', 'open', 'billing,enterprise');
        r5open_commaArea = r5.id!;

        // Lookup-field indexing rides the same pipeline as everything else on
        // the record — wait for each to reach INDEXED before querying lookups.
        await pollUntilIndexed(r1open_billing, 'record');
        await pollUntilIndexed(r2open_support, 'record');
        await pollUntilIndexed(r3open_billing, 'record');
        await pollUntilIndexed(r4closed_billing, 'record');
        await pollUntilIndexed(r5open_commaArea, 'record');
    });

    afterAll(async () => {
        for (const id of [
            r1open_billing, r2open_support, r3open_billing, r4closed_billing, r5open_commaArea,
        ]) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('schema round-trips the composite lookup as fieldNames', async () => {
        const got = await client.schemas.getSchema({ id: schemaId });
        const composite = (got.lookupFields ?? []).find((lf) => (lf.fieldNames ?? []).length > 0);
        expect(composite?.fieldNames).toEqual(['status', 'area']);
        // fieldName is absent on a composite entry — a typed reader must
        // handle that, not assume it is always present. The wire sends an
        // explicit JSON null here (not an omitted key), so check for either —
        // `composite?.fieldName ?? undefined` normalizes null and undefined
        // to the same "absent" value before asserting.
        expect(composite?.fieldName ?? undefined).toBeUndefined();
    });

    test('fully specified tuple — field=status,area + two values matches exactly', async () => {
        const results = await client.records.lookupRecords({
            type: recordType,
            field: 'status,area',
            values: ['open', 'billing'],
        });
        const ids = (results.data ?? []).map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining([r1open_billing, r3open_billing]));
        expect(ids).not.toContain(r2open_support);   // right status, wrong area
        expect(ids).not.toContain(r4closed_billing);  // right area, wrong status
        expect(ids).not.toContain(r5open_commaArea);  // "billing,enterprise" != "billing"
        expect(results.nextCursor).toBeNull();
    });

    test('sortFrom narrows a fully specified tuple by the lookup field\'s sort key', async () => {
        // sortFrom/sortTo bound the lookup field's sort key (createdAt by
        // default here) — but only on a FULLY specified tuple, since the
        // ordering is continuous only within one exact combination, not
        // across the groups a partial tuple would return. Bound in the sort
        // field's own units: epoch milliseconds for createdAt/lastUpdated.
        const r3 = await client.records.getRecord({ id: r3open_billing });
        const sortFromMs = String(Date.parse(r3.createdAt!));
        const results = await client.records.lookupRecords({
            type: recordType,
            field: 'status,area',
            values: ['open', 'billing'],
            sortFrom: sortFromMs,
        });
        const ids = (results.data ?? []).map((r) => r.id);
        expect(ids).toContain(r3open_billing);
        expect(ids).not.toContain(r1open_billing); // created before the sortFrom bound
    });

    test('sortFrom on a PARTIAL tuple is rejected — narrowing needs a value for every field', async () => {
        // The server enforces this; shown here so a customer reading this
        // example doesn't need to discover it by trial and error.
        const sortFromMs = String(Date.parse((await client.records.getRecord({ id: r1open_billing })).createdAt!));
        await expect(client.records.lookupRecords({
            type: recordType,
            field: 'status,area',
            values: ['open'], // partial — only the leading `status` leg
            sortFrom: sortFromMs,
        })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('partial tuple — fewer values than declared groups by the unspecified leg', async () => {
        // Only `status` supplied (a leading run of [status, area]) — matches
        // every open ticket regardless of area, grouped by area.
        const results = await client.records.lookupRecords({
            type: recordType,
            field: 'status,area',
            values: ['open'],
        });
        const ids = (results.data ?? []).map((r) => r.id);
        // r5's status is also "open" — its distinct area ("billing,enterprise")
        // makes it a third group, and it belongs here too.
        expect(ids).toEqual(expect.arrayContaining(
            [r1open_billing, r2open_support, r3open_billing, r5open_commaArea]));
        expect(ids).not.toContain(r4closed_billing); // status doesn't match — excluded regardless of grouping

        // Grouped by area: the two "billing" records are adjacent to each
        // other, and neither the "support" nor the "billing,enterprise"
        // record sits between them.
        const billingIdx = [ids.indexOf(r1open_billing), ids.indexOf(r3open_billing)];
        const supportIdx = ids.indexOf(r2open_support);
        const commaAreaIdx = ids.indexOf(r5open_commaArea);
        const [lo, hi] = [Math.min(...billingIdx), Math.max(...billingIdx)];
        expect(hi - lo).toBe(1); // adjacent, nothing else interleaved between them
        expect(supportIdx < lo || supportIdx > hi).toBe(true);
        expect(commaAreaIdx < lo || commaAreaIdx > hi).toBe(true);

        // sortBy (createdAt, the default) orders WITHIN the group: r1 was
        // created before r3, so it sorts first inside the "billing" group.
        expect(ids.indexOf(r1open_billing)).toBeLessThan(ids.indexOf(r3open_billing));
    });

    test('a comma-bearing value survives as one leg, not split (array-serialization safety)', async () => {
        // If the client comma-joined `values` instead of sending it as a
        // repeated query parameter, `values: ['open', 'billing,enterprise']`
        // would arrive at the server looking like a 3-element list — one leg
        // too many for a 2-field lookup — rather than the 2-element list it
        // actually is. Either way this record would fail to come back
        // matched on its true (2-value) tuple, so this assertion fails one
        // way or another if the encoding regresses.
        const results = await client.records.lookupRecords({
            type: recordType,
            field: 'status,area',
            values: ['open', 'billing,enterprise'],
        });
        const ids = (results.data ?? []).map((r) => r.id);
        expect(ids).toContain(r5open_commaArea);
        expect(ids).not.toContain(r1open_billing); // "billing" != "billing,enterprise"
    });

    test('POST body variant (lookupRecordsByBody) takes values as a plain array — no query-string encoding at all', async () => {
        // The body variant has no array-in-query-string question to begin
        // with (values travels as a JSON array), so it's shown here for
        // parity with the GET form rather than as its own regression check.
        const results = await client.records.lookupRecordsByBody({
            type: recordType,
            field: 'status,area',
            values: ['open', 'billing,enterprise'],
        });
        const ids = (results.data ?? []).map((r) => r.id);
        expect(ids).toEqual([r5open_commaArea]);
    });
});
