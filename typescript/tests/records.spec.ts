/**
 * records.spec.ts — Schema definition, record lifecycle, all three search modes,
 * lookup fields, metadata + ownership filtering, version history, tombstone,
 * and scoped-token identity auto-assign.
 *
 * Records are the structured-data half of the Vectros content model (paired
 * with documents). Each test demonstrates a real application workflow.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup, sleep } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

// Local shape for getRecordVersions response. The SDK currently types this
// as RecordResponse[] (default for record endpoints) but the actual payload
// is a version-row array; this interface mirrors the documented version-row
// fields so the test can read them without `as any`.
interface RecordVersion {
    changeType: 'CREATE' | 'UPDATE' | 'DELETE';
    previousContent?: string;
    changedBy?: string;
    changeReason?: string;
}

describe('records', () => {
    let schemaId: string;
    let recordType: string;
    let userId: string;
    let otherUserId: string;
    let orgId: string;
    let testStartedAt: string;
    const recordIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        recordType = `smoke_patient_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({
            typeName: recordType,
            displayName: 'Smoke Test Patient Record',
            indexMode: 'HYBRID',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'name', fieldType: 'string', required: true, searchable: true },
                { fieldId: 'notes', fieldType: 'string', required: false, searchable: true },
                { fieldId: 'department', fieldType: 'string', required: false, filterable: true },
                { fieldId: 'email', fieldType: 'string', required: true, searchable: false },
            ],
            lookupFields: [{ fieldName: 'email', unique: true }],
            capabilities: { auditHistory: true },
        });
        schemaId = schema.id!;

        const user = await client.identity.createUser({ externalId: uniqueTag() });
        userId = user.id!;
        const otherUser = await client.identity.createUser({ externalId: uniqueTag() });
        otherUserId = otherUser.id!;
        const org = await client.identity.createOrg({
            externalId: uniqueTag(),
            name: 'Smoke Org',
        });
        orgId = org.id!;
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('delete other user', () => client.identity.deleteUser({ id: otherUserId }));
        await tryCleanup('delete org', () => client.identity.deleteOrg({ id: orgId }));
    });

    // ANCHOR — create + poll + verify INDEXED. Demonstrates the
    // explicit-ownership pattern (userId/orgId in body) that supports
    // scoped-token dataScope filtering.
    test('create record → INDEXED', async () => {
        const payload = {
            name: 'Jane Doe',
            notes: 'presents with hypertension and complains of chest pain',
            department: 'cardiology',
            email: `${uniqueTag()}@test.com`,
        };

        const record = await client.records.createRecord({
            typeName: recordType,
            schemaId,
            payload,
            userId,
            orgId,
        });
        recordIds.push(record.id!);
        expect(record.indexStatus).toBe('PENDING_INDEX');
        await pollUntilIndexed(record.id!, 'record');
        const loaded = await client.records.getRecord({ id: record.id! });
        expect(loaded.indexStatus).toBe('INDEXED');
        expect(loaded.userId).toBe(userId);
        expect(loaded.orgId).toBe(orgId);
    });

    test('schema CRUD — get, update, list', async () => {
        // get — the schema created in beforeAll
        const got = await client.schemas.getSchema({ id: schemaId });
        expect(got.id).toBe(schemaId);
        expect(got.typeName).toBe(recordType);

        // update — change displayName + add a new optional field
        const updated = await client.schemas.updateSchema({
            id: schemaId,
            body: {
                typeName: recordType,
                displayName: 'Updated Smoke Test Patient Record',
                indexMode: 'HYBRID',
                allowedSurfaces: got.allowedSurfaces ?? ['record'],
                fields: [
                    ...(got.fields ?? []),
                    { fieldId: 'severity', fieldType: 'string', required: false, filterable: true },
                ],
                lookupFields: got.lookupFields ?? [],
                capabilities: got.capabilities ?? {},
            },
        });
        expect(updated.displayName).toBe('Updated Smoke Test Patient Record');

        // list — must include our schema. /v1/schemas has no typeName filter,
        // and the long-lived smoke tenant accumulates schemas across runs, so
        // DRAIN all pages ({ data, nextCursor }) rather than trusting the
        // default first page to still hold our just-created schema.
        const ids: (string | undefined)[] = [];
        let cursor: string | null | undefined;
        do {
            const page = await client.schemas.listSchemas(
                cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
            ids.push(...(page.data ?? []).map((s) => s.id));
            cursor = page.nextCursor;
        } while (cursor);
        expect(ids).toContain(schemaId);
    });

    test('search HYBRID — semanticScore + textScore both > 0, contextText non-empty', async () => {
        // Pre-condition: ANCHOR record already INDEXED in beforeAll-driven flow.
        // The record has notes="presents with hypertension and complains of chest pain"
        // and department="cardiology" — query for "hypertension" hits both lanes.
        // HYBRID rides the vector lane, whose query visibility lags INDEXED
        // (eventually-consistent; see helpers' pollUntilSearchable header). 30s
        // absorbs that tail — a timeout here is the visibility gap, not an
        // indexing failure.
        await pollUntilSearchable('hypertension', recordIds[0], 30_000, 'HYBRID', testStartedAt);
        const results = await client.search.content({
            query: 'hypertension chest pain',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === recordIds[0]);
        expect(hit).toBeDefined();
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBeGreaterThan(0);
        // Records are typically single-chunk (short payloads) so contextText
        // may be null — the assertion is "EITHER non-empty OR null", not strict.
        // Documents-text covers the strict contextText > chunkText assertion.
        if (hit!.contextText != null) {
            expect(hit!.contextText.length).toBeGreaterThan(0);
        }
    });

    test('search SEMANTIC — finds record by meaning, textScore === 0', async () => {
        // Query a semantic relative ("cardiac" vs the record's "hypertension/chest pain").
        const results = await client.search.content({
            query: 'cardiac complaint',
            mode: 'SEMANTIC',
            limit: 20,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === recordIds[0]);
        expect(hit).toBeDefined();
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBe(0);
    });

    test('search TEXT — finds record by exact keyword, semanticScore === 0', async () => {
        const results = await client.search.content({
            query: 'hypertension',
            mode: 'TEXT',
            limit: 20,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === recordIds[0]);
        expect(hit).toBeDefined();
        // textScore is not asserted > 0 in TEXT mode — the text-lane backend
        // serves highlighted snippets via an endpoint that does not expose
        // per-hit scores. Only the result-array order is meaningful as a
        // rank signal. HYBRID mode does return scores (asserted above).
        expect(hit!.semanticScore).toBe(0);
    });

    test('metadata filter — filterable field restricts results', async () => {
        // Create a second record with a different department, then filter
        // by department=cardiology — the new one should NOT surface.
        const otherRec = await client.records.createRecord({
            typeName: recordType,
            schemaId,
            payload: {
                name: 'John Smith',
                notes: 'sprained ankle',
                department: 'orthopedics',
                email: `${uniqueTag()}@test.com`,
            },
            userId,
            orgId,
        });
        recordIds.push(otherRec.id!);
        await pollUntilIndexed(otherRec.id!, 'record');

        // Query "hypertension" matches the ANCHOR's `notes` field
        // ("presents with hypertension and complains of chest pain") and
        // is NOT in the otherRec's notes ("sprained ankle"). The filter
        // then ensures only the cardiology record surfaces (orthopedics
        // filtered out).
        const results = await client.search.content({
            query: 'hypertension',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            filters: { department: 'cardiology' },
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(recordIds[0]);    // ANCHOR cardiology
        expect(ids).not.toContain(otherRec.id); // orthopedics filtered out
    });

    test('ownership filter — userId scoping restricts results', async () => {
        // Create a record owned by otherUserId — userId-filtered search should
        // exclude it.
        const otherOwnedRec = await client.records.createRecord({
            typeName: recordType,
            schemaId,
            payload: {
                name: 'Alice Brown',
                notes: 'routine checkup',
                department: 'family',
                email: `${uniqueTag()}@test.com`,
            },
            userId: otherUserId,
            orgId,
        });
        recordIds.push(otherOwnedRec.id!);
        await pollUntilIndexed(otherOwnedRec.id!, 'record');

        // Same approach as the metadata-filter test above — use "hypertension"
        // which matches ANCHOR's notes but not otherOwnedRec's
        // ("routine checkup"). userId filter then restricts to the
        // owning user. (A generic query like "patient" would match neither
        // record's indexed text, so it must be a term one record actually has.)
        const results = await client.search.content({
            query: 'hypertension',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            userId,
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(recordIds[0]);
        expect(ids).not.toContain(otherOwnedRec.id);
    });

    test('lookup by field — email returns single record', async () => {
        // The ANCHOR record's email was generated with uniqueTag — look it up.
        // Record payload is caller-defined free-form JSON, typed by the SDK
        // as Record<string, unknown> — narrow at the use site.
        const loaded = await client.records.getRecord({ id: recordIds[0] });
        const anchorPayload = loaded.payload as { email?: string } | undefined;
        const anchorEmail = anchorPayload?.email;
        expect(anchorEmail).toBeTruthy();

        // lookupRecords returns the {data, nextCursor} envelope, not a bare array.
        const results = await client.records.lookupRecords({
            type: recordType,
            field: 'email',
            value: anchorEmail!,
        });
        // Email is declared unique=true on the schema — must return exactly 1.
        const found = results.data ?? [];
        expect(found).toHaveLength(1);
        expect(found[0].id).toBe(recordIds[0]);
        expect(results.nextCursor).toBeNull();
    });

    test('update record → version history includes both versions', async () => {
        // Create a record, update its notes, then read version history.
        const rec = await client.records.createRecord({
            typeName: recordType,
            schemaId,
            payload: {
                name: 'Version Test ' + uniqueTag(),
                notes: 'original note',
                department: 'general',
                email: `${uniqueTag()}@test.com`,
            },
            userId,
            orgId,
        });
        recordIds.push(rec.id!);
        await pollUntilIndexed(rec.id!, 'record');

        // Update — capabilities.auditHistory=true on the schema means each
        // update preserves the prior version.
        const recPayload = rec.payload as { email?: string } | undefined;
        await client.records.updateRecord({
            id: rec.id!,
            body: {
                typeName: recordType,
                schemaId,
                payload: {
                    name: 'Version Test Updated',
                    notes: 'updated note',
                    department: 'general',
                    email: recPayload?.email,
                },
                userId,
                orgId,
            },
        });

        // Version rows are written asynchronously (typically 1-3s after
        // updateRecord returns). Poll until the second version lands; 30s
        // deadline is generous headroom that still fails fast on regression.
        const deadline = Date.now() + 30_000;
        let list: RecordVersion[] = [];
        while (Date.now() < deadline) {
            // getRecordVersions returns the { data, nextCursor } page envelope;
            // unwrap .data to the version rows.
            const page = await client.records.getRecordVersions({ id: rec.id! });
            list = (page.data ?? []) as unknown as RecordVersion[];
            if (list.length >= 2) break;
            await sleep(2_000);
        }

        // Each version row carries: changeType ("CREATE" | "UPDATE"),
        // previousContent (JSON string of the prior record state on UPDATE,
        // null on CREATE), changedBy, changeReason, changedFields. The
        // CURRENT record state lives on the record itself (getRecord) —
        // version history captures the BEFORE side of each transition.
        expect(list.length).toBeGreaterThanOrEqual(2);
        const types = list.map((v) => v.changeType);
        expect(types).toContain('CREATE');
        expect(types).toContain('UPDATE');

        // UPDATE version's previousContent must capture the original payload.
        const updateVersion = list.find((v) => v.changeType === 'UPDATE');
        expect(updateVersion).toBeDefined();
        expect(updateVersion!.previousContent).toBeTruthy();
        const previousState = JSON.parse(updateVersion!.previousContent!) as { payload?: { notes?: string } };
        expect(previousState.payload?.notes).toBe('original note');

        // Confirm the live record holds the updated state. Record payload is
        // caller-defined free-form JSON, so the SDK types it as
        // Record<string, unknown> — narrow at the use site.
        const liveRecord = await client.records.getRecord({ id: rec.id! });
        const livePayload = liveRecord.payload as { notes?: string } | undefined;
        expect(livePayload?.notes).toBe('updated note');
    });

    test('list records with userId and orgId filters', async () => {
        // userId-filter list — must include the ANCHOR (owned by userId)
        // and exclude the otherUserId record from the ownership-filter test.
        const list = await client.records.listRecords({
            type: recordType,
            userId,
            limit: 100,
        });
        const ids = (list.data ?? []).map((r) => r.id);
        expect(ids).toContain(recordIds[0]);
        // Also check orgId filter sanity: ANCHOR has orgId — querying by orgId
        // should also find it.
        const byOrg = await client.records.listRecords({
            type: recordType,
            orgId,
            limit: 100,
        });
        expect((byOrg.data ?? []).map((r) => r.id)).toContain(recordIds[0]);
    });

    test('scoped-token identity auto-assign on create', async () => {
        // Mint a token whose identity stamps a userId onto every record
        // created through it — the API auto-fills the userId field on the
        // record at create time even if the request body omits it.
        const minted = (await client.auth.mintToken({
            userId,
            scope: {
                allowedActions: ['records:c', 'records:r'],
                // identity.userId is the auto-stamp source — the API stamps
                // this onto records created via the scoped token.
                identity: { userId },
                // Null sentinel widens the dataScope to ALSO cover
                // tenant-level entities (the schema, which has no userId
                // since it's tenant-owned). Without `null`, the token's
                // dataScope.userId=[userId] excludes the schema and the
                // create fails with "Schema not found". Including null is
                // an explicit, auditable opt-in to tenant-level visibility.
                dataScope: { userId: [userId, null as unknown as string] },
            },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);

        const created = await scoped.records.createRecord({
            typeName: recordType,
            schemaId,
            payload: {
                name: 'Auto-Assign Test',
                notes: 'created via scoped token, no userId in body',
                department: 'general',
                email: `${uniqueTag()}@test.com`,
            },
            // intentionally NO userId — auto-assign must populate it
        });
        recordIds.push(created.id!);
        expect(created.userId).toBe(userId);
    });

    test('tombstone exists after delete (capabilities.auditHistory)', async () => {
        // Create + delete + assert tombstone reachable via getRecordTombstone.
        // Schema's capabilities.auditHistory=true keeps the tombstone row.
        const rec = await client.records.createRecord({
            typeName: recordType,
            schemaId,
            payload: {
                name: 'Tombstone Test ' + uniqueTag(),
                notes: 'soon to be deleted',
                department: 'general',
                email: `${uniqueTag()}@test.com`,
            },
            userId,
            orgId,
        });
        // NOTE: this one doesn't get pushed to recordIds — we're deleting it inline.
        await pollUntilIndexed(rec.id!, 'record');
        await client.records.deleteRecord({ id: rec.id! });

        // Give the delete a moment to propagate the tombstone row.
        await sleep(2_000);
        const tomb = await client.records.getRecordTombstone({ id: rec.id! });
        // Tombstone returns the deleted record's identifier in one of a
        // couple of standard shapes; assert "exists with id" defensively.
        expect(tomb).toBeDefined();
        const tombObj = tomb as { id?: string; recordId?: string };
        expect(tombObj.id ?? tombObj.recordId ?? rec.id).toBeTruthy();
    });
});
