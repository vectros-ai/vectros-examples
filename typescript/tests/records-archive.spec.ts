/**
 * records-archive.spec.ts — Record ARCHIVED lifecycle.
 *
 * A record's `status` is the caller-controlled lifecycle field (distinct from the
 * read-only `indexStatus` pipeline field). Setting `status=ARCHIVED` soft-retracts
 * the record from search and RAG recall while KEEPING it stored: retrievable by id,
 * findable by structured-field lookup, and returned by `GET /v1/records`. Setting it
 * back to `ACTIVE` re-indexes and restores search visibility.
 *
 * This spec pins the full round-trip against the live API — the behaviour has ZERO
 * prior smoke coverage. Because search visibility on the vector lane is
 * eventually-consistent (see helpers' pollUntilSearchable header), each transition is
 * POLLED, not asserted on a bare sleep:
 *
 *   create HYBRID → INDEXED → search finds it
 *     → status=ARCHIVED → poll until search NO LONGER returns it (pollUntilSearchHitGone)
 *     → status=ACTIVE   → poll until searchable AGAIN (pollUntilSearchable)
 *
 * Throughout every phase the record must stay retrievable-by-id and listed by
 * `GET /v1/records` — archive retracts from SEARCH only, never from storage.
 */
import { client } from '../src/client';
import {
    uniqueTag,
    pollUntilIndexed,
    pollUntilSearchable,
    pollUntilSearchHitGone,
    tryCleanup,
} from '../src/helpers';

describe('records (ARCHIVED lifecycle)', () => {
    let schemaId: string;
    let recordType: string;
    let userId: string;
    let orgEntityId: string;
    let testStartedAt: string;
    const recordIds: string[] = [];

    // A unique token embedded in the record's searchable text so the archive
    // search assertions match ONLY this record — never an orphan from a prior
    // run that shares generic vocabulary. Combined with createdAfter scoping,
    // the expected id is the sole possible hit.
    const marker = `archivemarker_${uniqueTag()}`.replace(/-/g, '_');

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        recordType = `smoke_archive_${uniqueTag()}`.replace(/-/g, '_');
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Archive Record',
            indexMode: 'HYBRID',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string', required: true, searchable: true },
                { fieldId: 'body', fieldType: 'string', required: false, searchable: true },
            ],
        } });
        schemaId = schema.id!;

        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
        const org = await client.identity.createEntity({ namespace: 'org', body: { externalId: uniqueTag(), name: 'Smoke Archive Org' } });
        orgEntityId = org.id!;
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('delete org', () =>
            client.identity.deleteEntity({ namespace: 'org', id: orgEntityId }));
    });

    // Whole lifecycle in ONE test so the phases run against a single record in a
    // deterministic order (each transition depends on the prior one's state). A
    // long-ish timeout is expected: HYBRID rides the vector lane and each phase
    // waits out its eventually-consistent visibility flip.
    test('ACTIVE → ARCHIVED → ACTIVE: search visibility flips, storage never does', async () => {
        // ── Phase 0: create + INDEXED ─────────────────────────────────────────
        const record = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: {
                title: `Archive Lifecycle ${marker}`,
                body: `This record carries the unique token ${marker} for search assertions.`,
            },
            userId,
            scopes: [`org:${orgEntityId}`],
        } });
        recordIds.push(record.id!);
        const id = record.id!;
        // A fresh record starts ACTIVE (the default lifecycle status).
        expect(record.status ?? 'ACTIVE').toBe('ACTIVE');
        expect(record.indexStatus).toBe('PENDING_INDEX');

        await pollUntilIndexed(id, 'record');
        await pollUntilSearchable(marker, id, 30_000, 'HYBRID', testStartedAt);

        // ── Phase 1: ARCHIVE → retracted from search, still stored ────────────
        // PATCH is the natural partial-update verb for a single-field status flip:
        // it carries only `status`, leaving the payload untouched (a PUT would
        // require re-sending the whole body). RecordRequest.status accepts ARCHIVED.
        const archived = await client.records.patchRecord({ id, body: { status: 'ARCHIVED' } });
        expect(archived.status).toBe('ARCHIVED');

        // Search de-indexing is asynchronous — poll until the record STOPS
        // surfacing. A timeout here would be the regression signal (archive not
        // retracting from the index).
        await pollUntilSearchHitGone(marker, id, 30_000, 'HYBRID', testStartedAt);

        // ...but it is NEVER retracted from storage. Retrievable by id:
        const whileArchived = await client.records.getRecord({ id });
        expect(whileArchived.status).toBe('ARCHIVED');
        expect((whileArchived.payload as { title?: string }).title).toContain(marker);
        // ...and still returned by GET /v1/records (list is a storage view, not a
        // search view — archived records remain listed).
        expect(await listContainsRecord(recordType, id)).toBe(true);

        // ── Phase 2: REACTIVATE → re-indexed, searchable again ────────────────
        const reactivated = await client.records.patchRecord({ id, body: { status: 'ACTIVE' } });
        expect(reactivated.status).toBe('ACTIVE');

        // Re-indexing runs through the same async pipeline as the initial index;
        // poll until the record reaches INDEXED and then re-surfaces in search.
        await pollUntilIndexed(id, 'record');
        await pollUntilSearchable(marker, id, 30_000, 'HYBRID', testStartedAt);

        // Still listed + retrievable after the round-trip — a sanity backstop.
        expect(await listContainsRecord(recordType, id)).toBe(true);
        const final = await client.records.getRecord({ id });
        expect(final.status).toBe('ACTIVE');
        // 240s outer budget: the five sequential inner polls (index 60s + searchable
        // 30s + search-gone 30s + re-index 60s + searchable 30s) can sum to ~210s on a
        // slow-but-passing HYBRID run; keep headroom so a genuine lag surfaces as the
        // phase-specific assertion error, not a generic jest timeout.
    }, 240_000);

    test('archived record is still findable by GET /v1/records list', async () => {
        // A second, independent record archived at rest (no search round-trip) —
        // isolates the "archived stays listed" contract from the search-flip
        // timing above, so a list regression is attributable on its own.
        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { title: `Listed While Archived ${uniqueTag()}`, body: 'stored, not searched' },
            userId,
            scopes: [`org:${orgEntityId}`],
        } });
        recordIds.push(rec.id!);
        await pollUntilIndexed(rec.id!, 'record');

        await client.records.patchRecord({ id: rec.id!, body: { status: 'ARCHIVED' } });
        const loaded = await client.records.getRecord({ id: rec.id! });
        expect(loaded.status).toBe('ARCHIVED');
        expect(await listContainsRecord(recordType, rec.id!)).toBe(true);
    });
});

/**
 * Drains the paginated `GET /v1/records?type=` feed looking for a specific id.
 * The long-lived smoke tenant accumulates records across runs, so a single
 * default page cannot be trusted to still hold our record — walk every page.
 */
async function listContainsRecord(type: string, id: string): Promise<boolean> {
    let cursor: string | null | undefined;
    do {
        const page = await client.records.listRecords(
            cursor ? { type, startFrom: cursor, limit: 100 } : { type, limit: 100 });
        if ((page.data ?? []).some((r) => r.id === id)) return true;
        cursor = page.nextCursor;
    } while (cursor);
    return false;
}
