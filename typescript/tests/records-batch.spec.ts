/**
 * records-batch.spec.ts — `POST /v1/records/batch`: writing several records in one call.
 *
 * Two commit modes, and the difference between them is the whole point of the endpoint:
 *
 *   best_effort      each item commits independently — some can succeed while others fail
 *   all_or_nothing   every item commits in one transaction — if any item fails, nothing is written
 *
 * The response is HTTP 200 whenever the batch was *processed*, including when every item failed, so
 * the per-item `results` array is the thing to inspect, never the status code. Each result carries
 * the `index` of the item you sent, because results are not guaranteed to come back in order.
 *
 * Every assertion here is written to be discriminating: an `all_or_nothing` test that only counted
 * `failed` would pass just as happily against a `best_effort` implementation, so each one also reads
 * back through a second, independent path (a lookup, or a fresh `getRecord`) to prove the row is —
 * or is not — actually there.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('records: batch write', () => {
    const tag = uniqueTag();
    const parentType = `smoke_batch_parent_${tag}`;
    const childType = `smoke_batch_child_${tag}`;
    let parentSchemaId: string;
    let childSchemaId: string;
    const createdRecordIds: string[] = [];
    const createdSchemaIds: string[] = [];

    /** Every id a batch reports as written, so cleanup never depends on a test's own bookkeeping. */
    function harvest(results: any[]): void {
        for (const r of results ?? []) if (r?.id) createdRecordIds.push(r.id);
    }

    /** Find one item's result by the index it was submitted under, not by array position. */
    function at(results: any[], index: number): any {
        const hit = (results ?? []).find((r) => r.index === index);
        expect(hit).toBeDefined();
        return hit;
    }

    beforeAll(async () => {
        const parent = await client.schemas.createSchema({ body: {
            typeName: parentType,
            displayName: 'Smoke Batch Parent',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true },
                { fieldId: 'code', fieldType: 'string' },
            ],
            // `code` is declared unique so a batch can be made to collide on it — both against a
            // record already committed and against a sibling item in the same batch.
            lookupFields: [{ fieldName: 'code', unique: true }],
        } });
        parentSchemaId = parent.id!;
        createdSchemaIds.push(parentSchemaId);

        const child = await client.schemas.createSchema({ body: {
            typeName: childType,
            displayName: 'Smoke Batch Child',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true },
                {
                    fieldId: 'parent', fieldType: 'reference', cardinality: 'one',
                    targetTypeName: parentType, targetSurface: 'record',
                },
            ],
        } });
        childSchemaId = child.id!;
        createdSchemaIds.push(childSchemaId);
    });

    afterAll(async () => {
        for (const id of createdRecordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        for (const id of createdSchemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
    });

    // -------------------------------------------------------------------------
    // best_effort — the default
    // -------------------------------------------------------------------------

    test('best_effort commits the good items and reports the bad ones per item', async () => {
        const good = `be-good-${uniqueTag()}`;
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [
                { typeName: parentType, externalId: good, payload: { title: 'kept', code: `be-a-${tag}` } },
                // `title` is required — this item is a validation failure, nothing else.
                { typeName: parentType, payload: { code: `be-b-${tag}` } },
            ],
        });
        harvest(resp.results);

        expect(resp.succeeded).toBe(1);
        expect(resp.failed).toBe(1);
        expect(at(resp.results, 0).status).toBe('created');
        expect(at(resp.results, 1).status).toBe('invalid');
        expect(at(resp.results, 1).id).toBeFalsy();

        // The surviving item is genuinely committed, read back by a path the batch never touched.
        const readBack = await client.records.getRecord({ id: at(resp.results, 0).id });
        expect(readBack.externalId).toBe(good);
    });

    test('succeeded + failed always account for every item submitted', async () => {
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [
                { typeName: parentType, payload: { title: 'one', code: `cnt-a-${tag}` } },
                { typeName: parentType, payload: { title: 'two', code: `cnt-b-${tag}` } },
                { typeName: parentType, payload: { code: `cnt-c-${tag}` } },
            ],
        });
        harvest(resp.results);
        expect(resp.results).toHaveLength(3);
        expect(resp.succeeded + resp.failed).toBe(3);
        // The distribution, not just the total — 0/3 and 3/0 both satisfy the sum.
        expect(resp.succeeded).toBe(2);
        expect(resp.failed).toBe(1);
        expect(at(resp.results, 0).status).toBe('created');
        expect(at(resp.results, 1).status).toBe('created');
        expect(at(resp.results, 2).status).toBe('invalid');
    });

    // -------------------------------------------------------------------------
    // all_or_nothing — and the `not_committed` status that only it can produce
    // -------------------------------------------------------------------------

    test('all_or_nothing writes nothing when one item fails, and says so per item', async () => {
        const wouldHaveWorked = `aon-${uniqueTag()}`;
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'all_or_nothing',
            items: [
                { typeName: parentType, externalId: wouldHaveWorked, payload: { title: 'ok', code: `aon-a-${tag}` } },
                { typeName: parentType, payload: { code: `aon-b-${tag}` } },
            ],
        });
        harvest(resp.results);

        expect(resp.succeeded).toBe(0);
        expect(resp.failed).toBe(2);
        // The item that was itself fine is distinguishable from the item that was not: it did not
        // fail validation, the batch it rode failed around it.
        expect(at(resp.results, 0).status).toBe('not_committed');
        expect(at(resp.results, 1).status).toBe('invalid');

        // What makes this test discriminating: the good item is not there. Under best_effort it
        // would be, and every count above would look identical.
        const page: any = await client.records.listRecords({ type: parentType, limit: 100 });
        expect((page.data ?? []).some((r: any) => r.externalId === wouldHaveWorked)).toBe(false);
    });

    test('all_or_nothing commits every item when they all pass', async () => {
        const a = `aon-ok-a-${uniqueTag()}`;
        const b = `aon-ok-b-${uniqueTag()}`;
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'all_or_nothing',
            items: [
                { typeName: parentType, externalId: a, payload: { title: 'a', code: `ok-a-${tag}` } },
                { typeName: parentType, externalId: b, payload: { title: 'b', code: `ok-b-${tag}` } },
            ],
        });
        harvest(resp.results);
        expect(resp.succeeded).toBe(2);
        expect(resp.failed).toBe(0);
        for (const r of resp.results) expect(r.status).toBe('created');

        // Read back by ID, not by listing. A list is an index read that need not show a row the
        // instant it commits, so a positive assertion made through one is flaky in the false-RED
        // direction; the ids the batch returned give a point read that cannot be stale.
        for (const r of resp.results) {
            const row: any = await client.records.getRecord({ id: r.id });
            expect([a, b]).toContain(row.externalId);
        }
    });

    // -------------------------------------------------------------------------
    // Guards see rows staged earlier in the same batch
    // -------------------------------------------------------------------------

    test('a unique field collides against a SIBLING item in the same batch', async () => {
        const sharedCode = `dup-${uniqueTag()}`;
        const first = `sib-a-${uniqueTag()}`;
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'all_or_nothing',
            items: [
                { typeName: parentType, externalId: first, payload: { title: 'first', code: sharedCode } },
                { typeName: parentType, externalId: `sib-b-${uniqueTag()}`, payload: { title: 'second', code: sharedCode } },
            ],
        });
        harvest(resp.results);

        // Neither is written: the uniqueness guard sees the sibling staged ahead of it, so the
        // second item is refused rather than admitted to collide at commit time.
        expect(resp.succeeded).toBe(0);
        // The DISCRIMINATING half. Counting failures alone is green against an implementation with no
        // staged-row guard at all, where both items are admitted and the transaction merely aborts at
        // commit. The per-item statuses separate the two: the second item is the OFFENDER
        // (`conflict`), the first is a BYSTANDER the abort took with it (`not_committed`).
        expect(at(resp.results, 1).status).toBe('conflict');
        expect(at(resp.results, 0).status).toBe('not_committed');

        const page: any = await client.records.listRecords({ type: parentType, limit: 100 });
        expect((page.data ?? []).some((r: any) => r.externalId === first)).toBe(false);
    });

    test('under best_effort the same clash commits the first item and rejects only the second', async () => {
        // The companion, and the sharper proof that the guard reads STAGED state: with no per-item
        // transaction to abort, an implementation without the guard would admit both writes and the
        // second would collide at the storage layer. Here the first commits and the second is refused
        // while the batch is still running.
        const sharedCode = `dup-be-${uniqueTag()}`;
        const first = `sibbe-a-${uniqueTag()}`;
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [
                { typeName: parentType, externalId: first, payload: { title: 'first', code: sharedCode } },
                { typeName: parentType, externalId: `sibbe-b-${uniqueTag()}`, payload: { title: 'second', code: sharedCode } },
            ],
        });
        harvest(resp.results);

        expect(at(resp.results, 0).status).toBe('created');
        expect(at(resp.results, 1).status).toBe('conflict');
        expect(resp.succeeded).toBe(1);

        // Point read on the id the batch returned — see the note above on why a list cannot carry a
        // positive assertion here.
        const committed: any = await client.records.getRecord({ id: at(resp.results, 0).id });
        expect(committed.externalId).toBe(first);
    });

    test('an item colliding with an ALREADY-COMMITTED row is a conflict too', async () => {
        // The other half of the uniqueness story the fixture was built for: the same guard has to see
        // committed rows as well as staged siblings, and only the staged half was asserted.
        const code = `pre-${uniqueTag()}`;
        const seeded = await client.records.createRecord({ body: {
            typeName: parentType, payload: { title: 'already here', code },
        } });
        createdRecordIds.push(seeded.id!);

        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [{ typeName: parentType, payload: { title: 'clashes', code } }],
        });
        harvest(resp.results);
        expect(at(resp.results, 0).status).toBe('conflict');
    });

    test('an item matching an existing externalId under ?upsert=true reports `updated`', async () => {
        // `updated` is one of the two SUCCESS statuses and was produced by no test here, so nothing
        // distinguished it from `created`.
        const externalId = `upd-${uniqueTag()}`;
        const first: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [{ typeName: parentType, externalId, payload: { title: 'v1', code: `upd-a-${uniqueTag()}` } }],
        });
        harvest(first.results);
        expect(at(first.results, 0).status).toBe('created');

        const second: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            upsert: true,
            items: [{ typeName: parentType, externalId, payload: { title: 'v2', code: `upd-b-${uniqueTag()}` } }],
        });
        harvest(second.results);
        expect(at(second.results, 0).status).toBe('updated');
        expect(second.succeeded).toBe(1);

        const readBack: any = await client.records.getRecord({ id: at(second.results, 0).id });
        expect((readBack.payload as any).title).toBe('v2');
    });

    test('a child item may reference a parent created earlier in the same all_or_nothing batch', async () => {
        const parentExternalId = `ref-parent-${uniqueTag()}`;
        const childExternalId = `ref-child-${uniqueTag()}`;
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'all_or_nothing',
            items: [
                {
                    typeName: parentType, externalId: parentExternalId,
                    payload: { title: 'parent', code: `ref-${tag}` },
                },
                {
                    typeName: childType, externalId: childExternalId,
                    payload: { title: 'child', parent: parentExternalId },
                },
            ],
        });
        harvest(resp.results);

        expect(resp.failed).toBe(0);
        expect(resp.succeeded).toBe(2);
        expect(at(resp.results, 1).status).toBe('created');

        // The reference is real — the child is committed and carries it.
        const child: any = await client.records.getRecord({ id: at(resp.results, 1).id });
        expect((child.payload as any)?.parent).toBe(parentExternalId);
    });

    test('a reference to a parent that exists NOWHERE is still refused', async () => {
        // The companion half of the test above, and what makes it discriminating: resolution is not
        // simply switched off inside a batch. A reference the batch does not itself create, and that
        // does not already exist, fails exactly as it would on a single create.
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'all_or_nothing',
            items: [
                {
                    typeName: childType, externalId: `ref-orphan-${uniqueTag()}`,
                    payload: { title: 'orphan', parent: `no-such-parent-${uniqueTag()}` },
                },
            ],
        });
        harvest(resp.results);
        expect(resp.succeeded).toBe(0);
        expect(at(resp.results, 0).status).toBe('invalid');
    });

    // -------------------------------------------------------------------------
    // Per-item scope enforcement
    // -------------------------------------------------------------------------

    test('an item your credential cannot write is `forbidden`, not `invalid`', async () => {
        // Scoped to the parent type only. The child item is a perfectly valid record the credential
        // simply may not write — the status has to say that, since the remedy is a different
        // credential rather than a different payload.
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: [`records:cr:${parentType}`] },
        })) as { token: string };
        const scoped = getScopedClient(minted.token);

        const resp: any = await scoped.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: [
                { typeName: parentType, payload: { title: 'permitted', code: `fb-a-${tag}` } },
                { typeName: childType, payload: { title: 'refused' } },
            ],
        });
        harvest(resp.results);

        expect(at(resp.results, 0).status).toBe('created');
        expect(at(resp.results, 1).status).toBe('forbidden');
    });

    // -------------------------------------------------------------------------
    // Request-shape refusals
    // -------------------------------------------------------------------------

    test('an unrecognised atomicity value is rejected, never silently defaulted', async () => {
        // A typo must not quietly downgrade a transactional batch to best_effort.
        await expect(client.records.batchWriteRecords({
            atomicity: 'all-or-nothing' as any,
            items: [{ typeName: parentType, payload: { title: 'x', code: `typo-${tag}` } }],
        })).rejects.toMatchObject({ statusCode: 400 });
    });
});

// ---------------------------------------------------------------------------
// The two limits, which fail in different directions and for different reasons.
// ---------------------------------------------------------------------------

describe('records: batch limits', () => {
    const wideType = `smoke_batch_wide_${uniqueTag()}`;
    const wideSchemaIds: string[] = [];
    const wideRecordIds: string[] = [];

    beforeAll(async () => {
        // Four range-indexed lookup fields, so each record costs its own row plus one per indexed
        // field — roughly five rows apiece. That puts a batch well inside the ITEM limit and well
        // past the ROW limit, which is the only way to reach the second refusal below.
        const schema = await client.schemas.createSchema({ body: {
            typeName: wideType,
            displayName: 'Smoke Batch Wide',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'a', fieldType: 'string' },
                { fieldId: 'b', fieldType: 'string' },
                { fieldId: 'c', fieldType: 'string' },
                { fieldId: 'd', fieldType: 'string' },
            ],
            lookupFields: [
                { fieldName: 'a', rangeEnabled: true },
                { fieldName: 'b', rangeEnabled: true },
                { fieldName: 'c', rangeEnabled: true },
                { fieldName: 'd', rangeEnabled: true },
            ],
        } });
        wideSchemaIds.push(schema.id!);
    });

    afterAll(async () => {
        for (const id of wideRecordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        for (const id of wideSchemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
    });

    const wideItems = (n: number, tag: string) =>
        Array.from({ length: n }, (_, i) => ({
            typeName: wideType,
            externalId: `${tag}-${i}`,
            payload: { a: `a${i}`, b: `b${i}`, c: `c${i}`, d: `d${i}` },
        }));

    test('more than 50 items is refused outright, on both atomicity modes', async () => {
        // A REQUEST-shape refusal: the batch is never processed, so this is a 4xx rather than a 200
        // carrying per-item results. A partner splitting a large import has to be able to tell the
        // two apart.
        for (const atomicity of ['best_effort', 'all_or_nothing'] as const) {
            await expect(client.records.batchWriteRecords({
                atomicity,
                items: wideItems(51, `over-${uniqueTag()}`),
            })).rejects.toMatchObject({ statusCode: 400 });
        }
    });

    test('exactly 50 items is accepted — the boundary is inclusive', async () => {
        // Without this, the cell above would pass just as happily against an off-by-one that
        // refused at 50, which would break a partner batching to the documented maximum.
        const resp: any = await client.records.batchWriteRecords({
            atomicity: 'best_effort',
            items: wideItems(50, `at-${uniqueTag()}`),
        });
        for (const r of resp.results ?? []) if (r?.id) wideRecordIds.push(r.id);
        expect(resp.results).toHaveLength(50);
        expect(resp.succeeded).toBe(50);
    });

    test('an all_or_nothing batch too large to commit ATOMICALLY is refused, and writes nothing', async () => {
        // Within the item limit and past the row limit. The distinction matters to a partner:
        // splitting by item count alone is not sufficient, because the bound is on underlying rows —
        // and the failure here would otherwise be a PARTIAL write, which is the worst outcome this
        // endpoint has.
        const tag = `rows-${uniqueTag()}`;
        let refused = false;
        try {
            const resp: any = await client.records.batchWriteRecords({
                atomicity: 'all_or_nothing',
                items: wideItems(50, tag),
            });
            for (const r of resp.results ?? []) if (r?.id) wideRecordIds.push(r.id);
            refused = resp.succeeded === 0;
        } catch {
            refused = true;
        }
        expect(refused).toBe(true);

        // Nothing was written — the assertion that makes this about ATOMICITY rather than about a
        // request being rejected.
        const page: any = await client.records.listRecords({ type: wideType, limit: 100 });
        expect((page.data ?? []).some((r: any) => String(r.externalId ?? '').startsWith(tag))).toBe(false);
    });
});
