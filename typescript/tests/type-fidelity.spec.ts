/**
 * type-fidelity.spec.ts — a schema's declared field TYPES survive the full
 * round-trip, and a partial update never trips a type error on a field it
 * didn't touch (nor drops data it didn't mention).
 *
 * The contract this pins, across records, identity entities, and documents:
 *   - a `number` field reads back as a JSON number (not the string "30") and a
 *     `boolean` as a JSON boolean, on EVERY read path — the create response,
 *     a GET by id, and a list page;
 *   - a resource stays updatable after create: changing one field never fails
 *     validation against an UNTOUCHED typed field, and that field keeps its
 *     type and value across the write;
 *   - an idempotent no-op upsert (re-applying a byte-identical body) is a true
 *     no-op — no new version is cut;
 *   - a large payload field is preserved intact across a partial update.
 *
 * A schema declares the type; the platform is the source of truth for it on
 * read, regardless of how the value is stored underneath. These tests assert
 * the numeric VALUE and JS type (`=== 30`, `typeof === 'number'`), never a
 * string rendering — a number is a number however it is persisted.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('type fidelity', () => {
    // ---- records ----------------------------------------------------------
    describe('records', () => {
        let schemaId: string;
        let recordType: string;
        const recordIds: string[] = [];

        beforeAll(async () => {
            recordType = `smoke_typefidelity_${uniqueTag()}`.replace(/-/g, '_');
            const schema = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Type Fidelity Schema',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [
                    { fieldId: 'priority', fieldType: 'number', required: true, searchable: false },
                    { fieldId: 'active', fieldType: 'boolean', required: false },
                    { fieldId: 'note', fieldType: 'string', required: false, searchable: true },
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

        test('typed fields round-trip as their declared JSON types (create / get / list)', async () => {
            const created = await client.records.createRecord({ body: {
                typeName: recordType, schemaId,
                payload: { priority: 30, active: true, note: 'hello' },
            } });
            recordIds.push(created.id!);

            // Create response.
            const cp = created.payload as { priority?: unknown; active?: unknown };
            expect(typeof cp.priority).toBe('number');
            expect(cp.priority).toBe(30);
            expect(typeof cp.active).toBe('boolean');
            expect(cp.active).toBe(true);

            // GET by id.
            const got = await client.records.getRecord({ id: created.id! });
            const gp = got.payload as { priority?: unknown; active?: unknown };
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(30);
            expect(typeof gp.active).toBe('boolean');

            // List page.
            const list = await client.records.listRecords({ type: recordType, limit: 100 });
            const hit = (list.data ?? []).find((r) => r.id === created.id);
            expect(hit).toBeDefined();
            expect(typeof (hit!.payload as { priority?: unknown }).priority).toBe('number');
            expect((hit!.payload as { priority?: unknown }).priority).toBe(30);
        });

        test('a large whole-number identifier is stored exactly when sent as a string', async () => {
            // Since 0.36.0 every number must fall within the signed 64-bit range,
            // and an out-of-range value is refused with a 400. JS itself cannot
            // represent such a value exactly either — 2^63 rounds as a double. The
            // pattern for a large whole-number identifier is therefore a STRING
            // field: it stores the digits byte-exact and supports exact-match
            // lookup, where a `number` field would round or reject.
            const bigId = '9223372036854775000';   // near 2^63 — exact only as a string
            const created = await client.records.createRecord({ body: {
                typeName: recordType, schemaId,
                payload: { priority: 1, note: bigId },
            } });
            recordIds.push(created.id!);

            const got = await client.records.getRecord({ id: created.id! });
            const gp = got.payload as { note?: unknown };
            expect(typeof gp.note).toBe('string');
            expect(gp.note).toBe(bigId);   // no float rounding — the digits survive exactly
        });

        test('a number field outside the signed 64-bit range is refused with 400', async () => {
            // The fail-closed half of the rule the previous test's guidance names:
            // a `number` field (here `priority`) holding a value beyond the signed
            // 64-bit range is rejected up front, rather than silently rounded.
            await expect(client.records.createRecord({ body: {
                typeName: recordType, schemaId,
                payload: { priority: 1e19 },   // > 2^63 (~9.22e18) — out of range
            } })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('a record stays updatable — a partial update never trips a type error on an untouched field', async () => {
            const created = await client.records.createRecord({ body: {
                typeName: recordType, schemaId,
                payload: { priority: 42, active: false, note: 'before' },
            } });
            recordIds.push(created.id!);

            // PATCH only `note`. `priority` is never mentioned — yet a stale-type
            // read would make the whole-payload re-validation reject this write.
            const patched = await client.records.patchRecord({ id: created.id!, body: { payload: { note: 'after' } } });
            expect(patched.version).toBe(created.version! + 1);

            const got = await client.records.getRecord({ id: created.id! });
            const gp = got.payload as { priority?: unknown; note?: unknown };
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(42);
            expect(gp.note).toBe('after');
        });

        test('an identical no-op upsert cuts no new version', async () => {
            const externalId = uniqueTag();
            const body = { typeName: recordType, schemaId, externalId, payload: { priority: 7, active: true, note: 'stable' } };
            const created = await client.records.createRecord({ body });
            recordIds.push(created.id!);
            const v0 = created.version!;

            // Re-apply the byte-identical body via upsert. A number compared as
            // its string rendering would never match, forcing a spurious rewrite;
            // the contract is that an unchanged body is a true no-op.
            const again = await client.records.createRecord({ upsert: true, body });
            expect(again.id).toBe(created.id);
            expect(again.created).toBe(false);

            const got = await client.records.getRecord({ id: created.id! });
            expect(got.version).toBe(v0);
        });

        test('a large payload field is preserved intact across a partial update', async () => {
            const blob = 'x'.repeat(60_000);
            const created = await client.records.createRecord({ body: {
                typeName: recordType, schemaId,
                payload: { priority: 5, note: blob },
            } });
            recordIds.push(created.id!);

            // Change one small field; the large `note` is never re-sent.
            await client.records.patchRecord({ id: created.id!, body: { payload: { active: true } } });

            const got = await client.records.getRecord({ id: created.id! });
            const gp = got.payload as { priority?: unknown; note?: string };
            expect((gp.note ?? '').length).toBe(60_000);
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(5);
        });
    });

    // ---- identity entities ------------------------------------------------
    describe('identity entities', () => {
        let schemaId: string;
        const entityIds: string[] = [];

        beforeAll(async () => {
            const schema = await client.schemas.createSchema({ body: {
                typeName: `smoke_entity_typefidelity_${uniqueTag()}`.replace(/-/g, '_'),
                displayName: 'Entity Type Fidelity Schema',
                indexMode: 'TEXT',
                allowedSurfaces: ['entity'],
                fields: [
                    { fieldId: 'priority', fieldType: 'number', required: true },
                    { fieldId: 'active', fieldType: 'boolean', required: false },
                ],
            } });
            schemaId = schema.id!;
        });

        afterAll(async () => {
            for (const id of entityIds) {
                await tryCleanup(`delete entity ${id}`, () => client.identity.deleteEntity({ namespace: 'org', id }));
            }
            await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        });

        test('entity typed fields round-trip as their declared JSON types (get / list)', async () => {
            const externalId = uniqueTag();
            const entity = await client.identity.createEntity({ namespace: 'org', body: {
                externalId, name: 'Type Fidelity Org', schemaId, payload: { priority: 3, active: true },
            } });
            entityIds.push(entity.id!);

            const got = await client.identity.getEntity({ namespace: 'org', id: entity.id! });
            const gp = got.payload as { priority?: unknown; active?: unknown };
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(3);
            expect(typeof gp.active).toBe('boolean');
            expect(gp.active).toBe(true);

            const list = await client.identity.listEntities({ namespace: 'org', externalId });
            const hit = (list.data ?? []).find((e) => e.id === entity.id);
            expect(hit).toBeDefined();
            expect(typeof (hit!.payload as { priority?: unknown }).priority).toBe('number');
            expect((hit!.payload as { priority?: unknown }).priority).toBe(3);
        });

        test('an entity stays updatable — a rename never trips a type error on the typed payload', async () => {
            const externalId = uniqueTag();
            const entity = await client.identity.createEntity({ namespace: 'org', body: {
                externalId, name: 'Before Rename', schemaId, payload: { priority: 9, active: false },
            } });
            entityIds.push(entity.id!);

            // Update only `name`; the stored typed payload is carried forward and
            // must not fail its own schema on the untouched `priority`.
            const updated = await client.identity.updateEntity({ namespace: 'org', id: entity.id!, body: {
                externalId, name: 'After Rename',
            } });
            expect(updated.name).toBe('After Rename');

            const got = await client.identity.getEntity({ namespace: 'org', id: entity.id! });
            const gp = got.payload as { priority?: unknown };
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(9);
        });
    });

    // ---- documents --------------------------------------------------------
    describe('documents', () => {
        let schemaId: string;
        let docType: string;
        const docIds: string[] = [];

        beforeAll(async () => {
            docType = `smoke_doc_typefidelity_${uniqueTag()}`.replace(/-/g, '_');
            const schema = await client.schemas.createSchema({ body: {
                typeName: docType,
                displayName: 'Document Type Fidelity Schema',
                indexMode: 'TEXT',
                allowedSurfaces: ['document'],
                fields: [
                    { fieldId: 'priority', fieldType: 'number', required: false, filterable: true },
                    { fieldId: 'active', fieldType: 'boolean', required: false },
                    { fieldId: 'note', fieldType: 'string', required: false },
                ],
            } });
            schemaId = schema.id!;
        });

        afterAll(async () => {
            for (const id of docIds) {
                await tryCleanup(`delete document ${id}`, () => client.documents.deleteDocument({ id }));
            }
            await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        });

        test('document typed fields round-trip as their declared JSON types', async () => {
            const doc = await client.documents.ingestDocument({ body: {
                title: 'Type Fidelity Document ' + uniqueTag(),
                text: 'a clinical note for type-fidelity assertions',
                indexMode: 'TEXT',
                schemaId,
                payload: { priority: 7, active: false, note: 'hello' },
            } });
            docIds.push(doc.id!);

            const got = await client.documents.getDocument({ id: doc.id! });
            const gp = got.payload as { priority?: unknown; active?: unknown };
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(7);
            expect(typeof gp.active).toBe('boolean');
            expect(gp.active).toBe(false);
        });

        test('a document stays updatable and preserves untouched payload data across a partial update', async () => {
            const blob = 'y'.repeat(60_000);
            const title = 'Type Fidelity Doc (partial update) ' + uniqueTag();
            const doc = await client.documents.ingestDocument({ body: {
                title,
                text: 'a clinical note for partial-update assertions',
                indexMode: 'TEXT',
                schemaId,
                payload: { priority: 11, note: blob },
            } });
            docIds.push(doc.id!);

            // PATCH one small field (the document's request re-sends its title, a
            // no-op). Neither `priority` (typed) nor the large `note` is re-sent —
            // both must survive the deep-merge intact.
            const patched = await client.documents.patchDocument({ id: doc.id!, body: { title, payload: { active: true } } });
            expect(patched.id).toBe(doc.id);

            const got = await client.documents.getDocument({ id: doc.id! });
            const gp = got.payload as { priority?: unknown; note?: string; active?: unknown };
            expect(typeof gp.priority).toBe('number');
            expect(gp.priority).toBe(11);
            expect((gp.note ?? '').length).toBe(60_000);
            expect(gp.active).toBe(true);
        });
    });
});
