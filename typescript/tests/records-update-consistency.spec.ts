/**
 * records-update-consistency.spec.ts — after a successful update, the OLD
 * content converges to no longer surfacing in search and the NEW content
 * converges to surfacing, within a generous timeout.
 *
 * An update replaces a record's indexed content behind the scenes; this test
 * proves that replacement lands end to end through the public API alone:
 * update a record, and confirm the old content is gone from search while the
 * new content is present. Asserting both directions matters — a cleanup that
 * races ahead of the write can leave a caller with neither version findable,
 * and one that lags can leave a stale version searchable alongside the new
 * one. (This polls each condition independently with a generous timeout, so
 * it proves eventual convergence — it is not a sub-second race detector for
 * a transient window where both or neither are momentarily visible.)
 */
import { client } from '../src/client';
import {
    uniqueTag,
    pollUntilIndexed,
    pollUntilSearchable,
    pollUntilSearchHitGone,
    tryCleanup,
} from '../src/helpers';

describe('records — update reflects in search (no stale content survives)', () => {
    let schemaId: string;
    let recordType: string;
    let testStartedAt: string;
    const recordIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        recordType = `smoke_updconsist_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Test Update Consistency',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true, searchable: true },
                { fieldId: 'body', fieldType: 'string', required: true, searchable: true },
            ],
        } });
        schemaId = schema.id!;
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('a successful update makes the new content searchable and the old content stops surfacing', async () => {
        const originalPhrase = 'ORIGINAL_' + uniqueTag().replace(/-/g, '_');
        const updatedPhrase = 'UPDATED_' + uniqueTag().replace(/-/g, '_');

        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { title: 'update consistency', body: originalPhrase },
        } });
        recordIds.push(rec.id!);
        await pollUntilIndexed(rec.id!, 'record');
        // Positive control: the original content is findable before we touch
        // it. Without this, "old content is gone" below would pass just as
        // well against a query that never matched anything.
        await pollUntilSearchable(originalPhrase, rec.id!, 30_000, 'TEXT', testStartedAt);

        await client.records.updateRecord({
            id: rec.id!,
            body: {
                typeName: recordType,
                schemaId,
                payload: { title: 'update consistency', body: updatedPhrase },
            },
        });
        await pollUntilIndexed(rec.id!, 'record');

        // The new content becomes searchable...
        await pollUntilSearchable(updatedPhrase, rec.id!, 30_000, 'TEXT', testStartedAt);
        // ...and the old content stops surfacing. Asserting both directions
        // matters: a cleanup that runs too eagerly can sweep away the
        // replacement along with the original (neither would be findable);
        // one that lags leaves the superseded version searchable alongside
        // the new one. Either failure shows up as one of these two checks
        // not holding.
        await pollUntilSearchHitGone(originalPhrase, rec.id!, 15_000, 'TEXT', testStartedAt);
    });
});
