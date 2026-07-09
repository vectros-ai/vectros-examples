/**
 * billing-exact.spec.ts — exact per-operation billing.
 *
 * The other usage assertions are directional (>=) because counters accumulate across runs. This
 * spec pins exact AMOUNTS instead, using before/after deltas of `credits.usedMilli` as the
 * isolated counter: the suite runs serially (`jest --runInBand`), so between two snapshots the
 * partner counter moves only for THIS spec's operations.
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
