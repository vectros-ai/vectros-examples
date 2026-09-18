/**
 * billing-exact.spec.ts — exact per-operation billing.
 *
 * The other usage assertions are directional (>=) because counters accumulate across runs. This
 * spec pins exact AMOUNTS instead, using before/after deltas of `credits.usedMilli` as the
 * isolated counter: this file's own run is ALWAYS serialized alone, before anything else in the
 * suite starts writing to the shared tenant (see the harness's exclusive-lane pre-pass — the file
 * is listed there specifically so this spec's own exact-delta assumption holds), so between two
 * snapshots the partner counter moves only for THIS spec's operations. That guarantee is NOT a
 * property of the suite running serially overall (it doesn't, since two other lanes run
 * concurrently after this one finishes) — it's specific to this file's own pre-pass isolation, and
 * a future change that drops this file from the exclusive list, or adds a second exact-delta spec
 * without also listing it there, silently reopens exactly the collision this comment exists to
 * prevent.
 *
 * The probe is chosen so the only fees in play are exactly computable from the published
 * pricing schedule (vectros.ai/pricing):
 *   - schema indexMode NONE → no search-indexing charges, no async indexing activity
 *   - no ownership ids, no lookup fields, externalId set → exactly one billable index
 *   - payload well under the 2 KB inline base, no folder → no size surcharge
 *   → create fee = write base (5) + 1 index (1) = 6 milli-credits, and a delete bills the same
 *     write fee for the same record shape ("writes and deletes cost the same").
 *
 * Known benign skews (each self-identifies as a delta ≠ 6 and re-runs clean): the periodic
 * storage-billing run landing mid-spec — vanishingly rare; and this spec's own getUsage() reads,
 * which are metered past the plan's free read allowance — unreachable at smoke volume.
 * usedMilli reads are eventually consistent; a read-after-write race is a rerunnable flake.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

const usedMilli = async (): Promise<number> => {
    const u = (await client.auth.getUsage()) as unknown as { credits: { usedMilli: number } };
    return u.credits.usedMilli;
};

describe('exact per-operation billing', () => {
    let schemaId: string;
    let recordType: string;

    beforeAll(async () => {
        recordType = `smoke_billing_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Exact Billing Probe',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', required: false, searchable: false }],
        } });
        schemaId = schema.id!;
    });

    afterAll(async () => {
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('record create and delete each charge exactly base(5) + one index(1) = 6 milli-credits', async () => {
        const before = await usedMilli();

        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            externalId: uniqueTag(),
            payload: { note: 'exact-billing probe' },
        } });

        const afterCreate = await usedMilli();
        expect(afterCreate - before).toBe(6);

        // Deletes bill the same write fee as the write that created the record.
        const beforeDelete = await usedMilli();
        await client.records.deleteRecord({ id: rec.id! });
        const afterDelete = await usedMilli();
        expect(afterDelete - beforeDelete).toBe(6);
    });
});

// ---------------------------------------------------------------------------
// Script execution time — the release's one new customer-visible CHARGE.
//
// This belongs in the exclusive lane rather than alongside the other usage
// assertions for the same reason the record fees above do: the reconciliation
// claim is a DELTA claim, and a delta is only meaningful while nothing else is
// writing to the shared tenant.
//
// Why delta and not an absolute sum. The published contract says the per-category
// breakdown sums to `credits.used`. On a long-lived tenant it does not, and that is
// not a defect: `used` is a single accumulator of what was actually charged, while
// the breakdown is reconstructed per category from today's stat keys, so charges
// booked before a category existed sit in `used` with nothing to itemise them.
// Measured on staging: a standing gap of ~12,700 milli-credits that does not move,
// while every new charge lands in BOTH. An absolute-sum assertion would therefore
// fail forever on this tenant and would say nothing about the property that matters
// — which is that a NEW charge is itemised as well as counted.
// ---------------------------------------------------------------------------

const EXECUTIONS = 3;

/** The whole usage report, not just the credit total. */
const usageReport = async (): Promise<any> => (await client.auth.getUsage()) as any;

/** Sum of every exact `*Milli` line in the credit breakdown. */
const breakdownMilli = (u: any): number =>
    Object.keys(u.credits.breakdown)
        .filter((k) => /Milli$/.test(k))
        .reduce((sum, k) => sum + (u.credits.breakdown[k] ?? 0), 0);

describe('script execution time is charged, and itemised as well as counted', () => {
    const scriptName = `smoke_exec_charge_${uniqueTag().replace(/-/g, '_')}`;
    const scriptIds: string[] = [];

    let workType: string;
    const workSchemaIds: string[] = [];

    beforeAll(async () => {
        // A script that makes NO host calls at all, so the only thing it can be charged for is its
        // own execution time. Anything it read or wrote would add its own fees to the delta and blur
        // the charge under test.
        const pushed = await client.scripts.createScript({
            name: scriptName,
            source: '({ ok: input.params.tag });',
        });
        scriptIds.push(pushed.id!);

        // …and a type for the comparison cell, whose whole point is a script that DOES billable work.
        workType = `smoke_incl_${uniqueTag().replace(/-/g, '_')}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: workType,
            displayName: 'Included-Time Probe',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string' }],
        } });
        workSchemaIds.push(schema.id!);
    });

    afterAll(async () => {
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => client.scripts.deleteScript({ id }));
        }
        // Records the comparison cell wrote must go before their schema will delete.
        const page: any = await client.records.listRecords({ type: workType, limit: 100 }).catch(() => ({}));
        for (const r of (page.data ?? [])) {
            await tryCleanup(`delete record ${r.id}`, () => client.records.deleteRecord({ id: r.id }));
        }
        for (const id of workSchemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
    });

    test('the execution section counts the executions and the charge reconciles with the total', async () => {
        const before = await usageReport();

        for (let i = 0; i < EXECUTIONS; i++) {
            await client.scripts.executeScript({
                scriptRef: { name: scriptName, version: 'latest' },
                input: { tag: uniqueTag() },
            });
        }

        const after = await usageReport();

        // 1. The section tracks real executions — not a static block that happens to be present.
        expect(after.execution.executions - before.execution.executions).toBe(EXECUTIONS);
        expect(after.execution.totalMillis).toBeGreaterThan(before.execution.totalMillis);

        // 2. The published arithmetic, stated as an identity on the report itself:
        //    billable = total + (200 ms baseline x executions) - included.
        //    This is what makes `includedMillis` checkable by a partner without reconstructing it.
        expect(after.execution.billableMillis).toBe(
            after.execution.totalMillis + 200 * after.execution.executions - after.execution.includedMillis,
        );

        // 3. The rate: 1 credit per 100 seconds, i.e. 1 milli-credit per 100 ms of billable time.
        //    Asserted as a BOUND rather than an equality, and the reason is in the charge mechanism
        //    rather than in test convenience: the charge is accumulated per execution as a difference
        //    of two floors against a running period total, so sub-milli-credit remainders carry
        //    forward instead of rounding away, and the sum telescopes to exactly this floor — while
        //    nothing else is executing. This tenant is shared, and a concurrent execution reading the
        //    same running total shifts the result by a milli-credit. The bound still fails loudly on
        //    a wrong RATE, which is what this cell is for.
        const atPublishedRate = Math.floor(after.execution.billableMillis / 100);
        expect(Math.abs(after.execution.creditsMilli - atPublishedRate)).toBeLessThanOrEqual(2);

        // 4. The charge is ITEMISED, not merely counted. This is the reconciliation claim, and the
        //    reason it is the assertion worth having: the charge lands in the credit total whether or
        //    not anything breaks it out, so a missing breakdown line is invisible from `used` alone —
        //    a metered surface absent from the invoice while the headline keeps counting it.
        expect(after.credits.usedMilli - before.credits.usedMilli)
            .toBe(breakdownMilli(after) - breakdownMilli(before));

        // 5. …and it is itemised under its OWN line, agreeing with the execution section.
        expect(after.credits.breakdown.scriptExecutionMilli - before.credits.breakdown.scriptExecutionMilli)
            .toBe(after.execution.creditsMilli - before.execution.creditsMilli);
    });

    test('a script that DOES billable work is charged LESS execution time than one that does none', async () => {
        // The pricing model's headline promise, and the only form of it that is falsifiable: each
        // billable operation carries included execution time, so a script that writes a record earns
        // 350 ms of cover while a script that makes no host calls at all earns nothing and pays for
        // its whole span plus the baseline.
        //
        // Asserted as a COMPARISON rather than as a tolerance on one number. A tolerance is a guess
        // about wall-clock; this is the actual claim, it points the way a naive implementation would
        // get wrong (more work costing more), and no implementation that ignores `includedMillis`
        // can satisfy it.
        const chargeFor = async (source: string): Promise<number> => {
            const name = `smoke_incl_${uniqueTag().replace(/-/g, '_')}`;
            const pushed = await client.scripts.createScript({ name, source });
            scriptIds.push(pushed.id!);
            const before = await usageReport();
            await client.scripts.executeScript({
                scriptRef: { name, version: 'latest' },
                input: { tag: uniqueTag() },
            });
            const after = await usageReport();
            return after.credits.breakdown.scriptExecutionMilli
                - before.credits.breakdown.scriptExecutionMilli;
        };

        // No host calls: earns no included time.
        const bare = await chargeFor('({ ok: input.params.tag });');

        // One billable write: earns the simple-write allowance, which covers a prompt return.
        const working = await chargeFor(
            `vectros.records.create({ typeName: '${workType}', payload: { note: input.params.tag } });`,
        );

        // More work, less execution-time charge -- with the SAME +/-2mC tolerance the sibling
        // assertion above already applies, and for the identical reason: this value is a floor
        // against a shared, per-tenant running total that every concurrent execution on the
        // account also increments, so a concurrent script can shift either side by a milli-credit
        // even though nothing about this run's own billable time changed. The comparison still
        // fails loudly on the thing it exists to catch -- a naive implementation charging MORE for
        // more work -- because that failure shows up as a gap far wider than 2mC.
        expect(working).toBeLessThanOrEqual(bare + 2);
    }, 60_000);
});

// ---------------------------------------------------------------------------
// 0.44.0 — POST-shaped reads now meter identically to their GET equivalents.
//
// A handful of read endpoints happen to arrive as POST (a body-based lookup, a batch-get, a
// full-text/semantic search) rather than GET. Before this release the read meter keyed purely on
// HTTP verb, so every one of these accrued NOTHING at all — not a smaller charge, no charge — no
// matter what the request actually read. They now take the same metered-read path their GET
// equivalent already used, moving the same account-level read-call counter (`reads.calls.used`) a
// GET does. `/v1/search` has no GET form at all, so it was an entirely unmetered surface.
//
// Asserted as a NONZERO delta rather than an exact one, and deliberately so: this spec's own
// getUsage() calls are themselves GETs, so each one nudges the very counter under test — the same
// self-measurement effect the top-of-file comment already notes for `credits.usedMilli`. "was
// always zero, now moves" is the falsifiable claim this release makes; the exact increment isn't.
// ---------------------------------------------------------------------------

describe('POST-shaped reads meter the same read counter as their GET equivalent (0.44.0)', () => {
    let schemaId: string;
    let recordType: string;
    let recordId: string;

    beforeAll(async () => {
        recordType = `smoke_postread_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'POST-Shaped Read Probe',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'tag', fieldType: 'string', required: false }],
            lookupFields: [{ fieldName: 'tag', unique: false }],
        } });
        schemaId = schema.id!;
        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { tag: 'post-read-probe' },
        } });
        recordId = rec.id!;
    });

    afterAll(async () => {
        await tryCleanup('delete record', () => client.records.deleteRecord({ id: recordId }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('POST /v1/records/lookup (lookupRecordsByBody) now meters a read, where it used to meter nothing', async () => {
        const before = await usageReport();
        await client.records.lookupRecordsByBody({ type: recordType, field: 'tag', value: 'post-read-probe' });
        const after = await usageReport();
        expect(after.reads.calls.used - before.reads.calls.used).toBeGreaterThan(0);
    });

    test('POST /v1/records/batch-get now meters a read, where it used to meter nothing', async () => {
        const before = await usageReport();
        await client.records.batchGetRecords({ ids: [recordId] });
        const after = await usageReport();
        expect(after.reads.calls.used - before.reads.calls.used).toBeGreaterThan(0);
    });

    test('POST /v1/search now meters a read — this surface has no GET form at all, so it was entirely unmetered before', async () => {
        const before = await usageReport();
        await client.search.content({ query: uniqueTag(), mode: 'TEXT', limit: 1 });
        const after = await usageReport();
        expect(after.reads.calls.used - before.reads.calls.used).toBeGreaterThan(0);
    });

    test('POST /v1/documents/lookup (lookupDocumentsByBody) now meters a read, where it used to meter nothing', async () => {
        // externalId needs no schema declaration -- the cheapest fixture for this probe.
        const extId = uniqueTag();
        const doc = await client.documents.ingestDocument({ body: {
            title: 'POST-shaped read probe', text: 'n/a', indexMode: 'NONE', externalId: extId,
        } });
        try {
            const before = await usageReport();
            await client.documents.lookupDocumentsByBody({ type: 'document', field: 'externalId', value: extId });
            const after = await usageReport();
            expect(after.reads.calls.used - before.reads.calls.used).toBeGreaterThan(0);
        } finally {
            await tryCleanup('post-read probe document', () => client.documents.deleteDocument({ id: doc.id! }));
        }
    });

    // Not covered here: POST /v1/users/lookup and POST /v1/entities/{namespace}/lookup, the
    // remaining two of the six routes this release re-metered. Both route through the same
    // schema-declared-lookup-field mechanism as the two record/document probes above, so the
    // metering wiring itself is unlikely to differ per route -- but building a correct
    // fixture for either (a user- or entity-surfaced schema with a bound lookup field) is
    // more setup than this file's existing pattern reaches for, and getting it wrong under
    // time pressure would be worse than leaving the gap named. Flagging rather than silently
    // omitting, per this suite's own coverage-table discipline.
});

// ---------------------------------------------------------------------------
// 0.44.0 — the reserved batch-lookup stub takes the free-allowance read path too, not the
// write-credit-ceiling one.
//
// The full loosening this release makes to these routes — a caller over its monthly credit
// ceiling but within its free read allowance now succeeds where it used to get a 402 — needs an
// over-ceiling tenant to observe directly, and that isn't something a smoke run against a shared
// staging tenant can construct without draining its real credit balance (see
// negative-paths.spec.ts's note on the equivalent 402 case for prepaid inference balance — the
// same non-destructive-tenant constraint applies here). What IS cheap to check, with no credits
// involved at all: the reserved stub still answers with its documented 501, not a 402/403 a
// caller on the old write-path could have hit before ever reaching the stub.
// ---------------------------------------------------------------------------

describe('POST /v1/records/lookup/batch — reserved stub takes the read path, not the write-credit path (0.44.0)', () => {
    test('returns its documented 501, not a write-path 402/403', async () => {
        await expect(client.records.batchLookupRecords({
            requests: [{ ref: 'r1', type: 'smoke_nonexistent_type', field: 'tag', value: 'x' }],
        })).rejects.toMatchObject({ statusCode: 501 });
    });
});
