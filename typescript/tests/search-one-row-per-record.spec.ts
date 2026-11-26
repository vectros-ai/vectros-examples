/**
 * search-one-row-per-record.spec.ts — a record that is written many times in
 * quick succession, starting from its create, is still served by search as
 * exactly ONE result row.
 *
 * Search keeps an index entry per record and refreshes it on every write. A
 * write that is processed before the entry made by the record's create is
 * visible must refresh that one entry, not add a second one beside it. A
 * second entry shows up as the same record returned twice for one query, and
 * the extra entry keeps the content it was written with after later writes
 * change the record.
 *
 * Writes that are spread out (one every few seconds) do not exercise this:
 * by then the create's entry is long visible. The two cases below put the
 * create and its follow-up writes as close together as the public API allows:
 *
 *   (a) create a record, then release 8 unversioned PATCHes of it at once,
 *       behind a barrier, the moment the create returns. Repeated on 3 fresh
 *       records.
 *   (b) one `best_effort` batch with `upsert: true` whose 8 items all name the
 *       same new `externalId`: item 1 creates the record and items 2-8 update
 *       it, each committed on its own, back to back, inside one request.
 *       (An `all_or_nothing` batch cannot stand in for this: it commits the
 *       whole batch as one write, so a record created and updated inside it
 *       is written once.)
 *
 * Each case then asserts exactly one result row for the record's unique word,
 * at 30 s and again at 120 s after its writes, with `uniqueDocuments: false`
 * so the count is what the index holds rather than what a read-time collapse
 * shows. The record's content is one short field, so one entry is one chunk
 * is one row; a control record written once confirms that before the
 * assertions mean anything.
 *
 * Slow lane: each case waits out its 120 s mark.
 */
import { client } from '../src/client';
import { uniqueTag, sleep, pollUntil, withRateLimitRetry, tryCleanup } from '../src/helpers';

const BURST = 8;
const BURST_RECORDS = 3;
const FIRST_CHECK_MS = 30_000;
const SECOND_CHECK_MS = 120_000;
const MAX_CONFLICT_ATTEMPTS = 5;

/** A single TEXT-search token: letters, digits and underscores only. */
function uniqueWord(prefix: string): string {
    return `${prefix}_${uniqueTag().replace(/-/g, '_')}`;
}

describe('search — one result row per record, however fast it is written', () => {
    let recordType: string;
    let schemaId: string;
    let testStartedAt: string;
    const recordIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        recordType = `smoke_onerow_${uniqueTag().replace(/-/g, '_')}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Test One Row Per Record',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [
                // `word` never changes after the create, so every entry the record
                // ever had still matches it: a stale extra entry cannot hide.
                { fieldId: 'word', fieldType: 'string', required: true, searchable: true },
                // `step` changes on every write, so every write is one search must re-index.
                { fieldId: 'step', fieldType: 'string', required: true, searchable: true },
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

    /**
     * An unversioned PATCH, retried on a `409`: concurrent writers to one record can conflict, and a `409` means nothing was written,
     * so retrying it keeps the burst at its full size. Bounded; any other error is thrown at once.
     */
    async function patchRetryingConflicts(id: string, payload: Record<string, unknown>): Promise<unknown> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await withRateLimitRetry(() => client.records.patchRecord({ id, body: { payload } }));
            } catch (err: any) {
                if (err?.statusCode !== 409 || attempt >= MAX_CONFLICT_ATTEMPTS) throw err;
                await sleep(50 + Math.floor(Math.random() * 200));
            }
        }
    }

    /** The result rows search returns for `word` that belong to `recordId`, uncollapsed. */
    async function rowsFor(word: string, recordId: string): Promise<number> {
        const results: any = await withRateLimitRetry(() => client.search.content({
            query: word,
            mode: 'TEXT',
            limit: 100,
            uniqueDocuments: false,
            createdAfter: testStartedAt,
        }));
        return (results.results ?? []).filter((r: any) => r.documentId === recordId).length;
    }

    /** Waits until the record is searchable, then counts its rows at each mark (ms after `writesDoneAt`). */
    async function rowCountsAt(word: string, recordId: string, writesDoneAt: number, marks: number[]): Promise<number[]> {
        await pollUntil(`a search row for ${recordId}`, async () => (await rowsFor(word, recordId)) > 0 || undefined,
            FIRST_CHECK_MS, 1_000);
        const counts: number[] = [];
        for (const mark of marks) {
            await sleep(Math.max(0, writesDoneAt + mark - Date.now()));
            counts.push(await rowsFor(word, recordId));
        }
        return counts;
    }

    test('control: a record written once is one row (one entry is one row for this content)', async () => {
        const word = uniqueWord('ONEROW_CONTROL');
        const rec = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { word, step: 'step_0' },
        } });
        recordIds.push(rec.id!);
        expect(await rowCountsAt(word, rec.id!, Date.now(), [FIRST_CHECK_MS])).toEqual([1]);
    }, 120_000);

    test(`(a) create, then ${BURST} simultaneous unversioned PATCHes, on ${BURST_RECORDS} fresh records: one row each at 30 s and 120 s`, async () => {
        const runs: { id: string; word: string; writesDoneAt: number }[] = [];
        for (let n = 0; n < BURST_RECORDS; n++) {
            const word = uniqueWord(`ONEROW_BURST${n}`);
            const rec = await client.records.createRecord({ body: {
                typeName: recordType, schemaId, payload: { word, step: 'step_0' },
            } });
            recordIds.push(rec.id!);

            // Barrier: every PATCH is built and waiting on `go` before any is sent.
            let release!: () => void;
            const go = new Promise<void>((resolve) => { release = resolve; });
            const patches = Array.from({ length: BURST }, (_, i) => go.then(() =>
                patchRetryingConflicts(rec.id!, { step: `step_${i + 1}` })));
            release();
            const settled = await Promise.allSettled(patches);
            const failures = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
            // Every PATCH must land: a 409 between concurrent writers wrote nothing and is retried (a bounded number of times).
            expect(failures.map((f) => String(f.reason))).toEqual([]);
            runs.push({ id: rec.id!, word, writesDoneAt: Date.now() });
        }

        // The records are checked together so the whole case costs one 120 s wait.
        const counts = await Promise.all(runs.map((r) => rowCountsAt(r.word, r.id, r.writesDoneAt, [FIRST_CHECK_MS, SECOND_CHECK_MS])));
        expect(counts.map(([at30, at120], i) => ({ record: runs[i].id, at30, at120 })))
            .toEqual(runs.map((r) => ({ record: r.id, at30: 1, at120: 1 })));
    }, 300_000);

    test(`(b) one best_effort upsert batch that creates a record and updates it ${BURST - 1} times: one row at 30 s and 120 s`, async () => {
        const word = uniqueWord('ONEROW_BATCH');
        const externalId = `onerow-${uniqueTag()}`;
        const resp: any = await withRateLimitRetry(() => client.records.batchWriteRecords({
            atomicity: 'best_effort',
            upsert: true,
            items: Array.from({ length: BURST }, (_, i) => ({
                typeName: recordType, externalId, payload: { word, step: `step_${i}` },
            })),
        }));
        const writesDoneAt = Date.now();
        const results: any[] = resp.results ?? [];
        const ids = [...new Set(results.map((r) => r.id).filter(Boolean))];
        ids.forEach((id) => recordIds.push(id));

        // Precondition: the batch really was one create followed by updates of that same record.
        expect(results.map((r) => r.status)).toEqual(['created', ...Array(BURST - 1).fill('updated')]);
        expect(ids).toHaveLength(1);

        const [at30, at120] = await rowCountsAt(word, ids[0], writesDoneAt, [FIRST_CHECK_MS, SECOND_CHECK_MS]);
        expect({ at30, at120 }).toEqual({ at30: 1, at120: 1 });
    }, 300_000);
});
