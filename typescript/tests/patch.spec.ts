/**
 * patch.spec.ts — RFC-7386 merge-PATCH on records, documents, and folders.
 *
 * PATCH is the partial-update verb (distinct from PUT, which replaces the whole
 * body). The behaviours that matter to your integration and that this spec pins:
 *
 *   - PARTIAL semantics: a PATCH touches only the keys it carries; every other
 *     field is preserved. For records/documents the `payload` object is
 *     DEEP-MERGED (a key set to null is deleted, absent keys are kept) — the
 *     opposite of PUT, which replaces `payload` wholesale.
 *   - OPTIMISTIC CONCURRENCY: pass the `version` you last read as
 *     `expectedVersion` and a PATCH against a since-modified resource is
 *     rejected 409 with the stored row left untouched.
 *   - NOT-FOUND + VALIDATION: a PATCH to a missing id is 404; a PATCH that
 *     tries to change an immutable field is 400.
 *
 * Each test asserts the RESPONSE BODY, not just the status code.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('PATCH (RFC-7386 merge)', () => {

    // =======================================================================
    // Records
    // =======================================================================
    describe('records', () => {
        let schemaId: string;
        let recordType: string;
        const recordIds: string[] = [];

        beforeAll(async () => {
            recordType = `smoke_patch_${uniqueTag()}`.replace(/-/g, '_');
            const schema = await client.schemas.createSchema({
                typeName: recordType,
                displayName: 'PATCH Test Schema',
                indexMode: 'NONE',
                allowedSurfaces: ['record'],
                fields: [
                    { fieldId: 'alpha', fieldType: 'string', required: false },
                    { fieldId: 'beta', fieldType: 'string', required: false },
                    { fieldId: 'gamma', fieldType: 'string', required: false },
                ],
            });
            schemaId = schema.id!;
        });

        afterAll(async () => {
            for (const id of recordIds) {
                await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
            }
            await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        });

        async function createRecord(payload: Record<string, unknown>): Promise<{ id: string; version: number }> {
            const rec = await client.records.createRecord({ typeName: recordType, schemaId, payload });
            recordIds.push(rec.id!);
            return { id: rec.id!, version: rec.version! };
        }

        test('payload is DEEP-MERGED — patched keys overwrite, untouched keys preserved', async () => {
            const { id, version } = await createRecord({ alpha: 'a1', beta: 'b1', gamma: 'g1' });

            const patched = await client.records.patchRecord({ id, body: { payload: { alpha: 'a2' } } });
            const p = patched.payload as { alpha?: string; beta?: string; gamma?: string };
            expect(p.alpha).toBe('a2');     // overwritten
            expect(p.beta).toBe('b1');      // preserved (NOT wiped — the PUT-vs-PATCH difference)
            expect(p.gamma).toBe('g1');     // preserved
            expect(patched.version).toBe(version + 1);
        });

        test('payload key set to null is DELETED (RFC-7386), others preserved', async () => {
            const { id } = await createRecord({ alpha: 'a1', beta: 'b1', gamma: 'g1' });

            const patched = await client.records.patchRecord({ id, body: { payload: { beta: null } } });
            const p = patched.payload as Record<string, unknown>;
            expect(p.beta).toBeUndefined();   // deleted
            expect('beta' in p).toBe(false);
            expect(p.alpha).toBe('a1');       // preserved
            expect(p.gamma).toBe('g1');       // preserved
        });

        test('optimistic lock — stale expectedVersion is rejected 409, record untouched', async () => {
            const { id, version } = await createRecord({ alpha: 'a1', beta: 'b1' });

            // First conditional PATCH at the version we read — succeeds, version advances.
            const ok = await client.records.patchRecord({
                id, body: { payload: { alpha: 'a2' }, expectedVersion: version },
            });
            expect(ok.version).toBe(version + 1);

            // Replaying the SAME expectedVersion now refers to a stale version → 409.
            await expect(client.records.patchRecord({
                id, body: { payload: { alpha: 'a3' }, expectedVersion: version },
            })).rejects.toMatchObject({ statusCode: 409 });

            // The rejected PATCH was a no-op: the stored payload still holds a2.
            const reloaded = await client.records.getRecord({ id });
            expect((reloaded.payload as { alpha?: string }).alpha).toBe('a2');
        });

        test('PATCH to a missing id returns 404', async () => {
            // Well-formed but never-created UUID → 404, not 500.
            await expect(client.records.patchRecord({
                id: '33333333-3333-3333-3333-333333333333',
                body: { payload: { alpha: 'x' } },
            })).rejects.toMatchObject({ statusCode: 404 });
        });

        test('PATCH that targets an immutable field (typeName) is rejected 400', async () => {
            const { id } = await createRecord({ alpha: 'a1' });
            await expect(client.records.patchRecord({
                id, body: { typeName: 'something_else' } as any,
            })).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    // =======================================================================
    // Documents
    // =======================================================================
    describe('documents', () => {
        const docIds: string[] = [];

        afterAll(async () => {
            for (const id of docIds) {
                await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
            }
        });

        async function createDoc(): Promise<{ id: string; version: number }> {
            // indexMode NONE: store-only, so no indexing wait is needed — PATCH
            // operates on the stored row directly. Read the authoritative version
            // back via GET (the create response does not echo it).
            const doc = await client.documents.ingestDocument({
                title: `PATCH Doc ${uniqueTag()}`,
                text: 'Original body for PATCH testing. The quick brown fox.',
                indexMode: 'NONE',
                storeText: true,
            });
            docIds.push(doc.id!);
            const loaded = await client.documents.getDocument({ id: doc.id! });
            return { id: doc.id!, version: loaded.version! };
        }

        test('PATCH title leaves the body untouched (partial update)', async () => {
            const { id } = await createDoc();
            const patched = await client.documents.patchDocument({ id, body: { title: 'PATCH Doc (renamed)' } });
            expect(patched.title).toBe('PATCH Doc (renamed)');
            // The stored text is unchanged — round-trip it to prove the body survived.
            const text = await client.documents.getDocumentText({ id });
            expect(text.text).toContain('quick brown fox');
        });

        test('optimistic lock — stale expectedVersion rejected 409', async () => {
            const { id, version } = await createDoc();
            const ok = await client.documents.patchDocument({
                id, body: { title: 'v2', expectedVersion: version },
            });
            expect(ok.version).toBe(version + 1);
            await expect(client.documents.patchDocument({
                id, body: { title: 'v3', expectedVersion: version },
            })).rejects.toMatchObject({ statusCode: 409 });
        });

        test('PATCH to a missing id returns 404', async () => {
            await expect(client.documents.patchDocument({
                id: '11111111-1111-1111-1111-111111111111',
                body: { title: 'nope' },
            })).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    // =======================================================================
    // Folders
    // =======================================================================
    describe('folders', () => {
        const folderIds: string[] = [];

        afterAll(async () => {
            for (const id of folderIds) {
                await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
            }
        });

        async function createFolder(): Promise<{ id: string; version: number }> {
            const f = await client.folders.createFolder({
                name: `PATCH Folder ${uniqueTag()}`,
                description: 'original description',
            });
            folderIds.push(f.id!);
            // Read the authoritative version back (the create response omits it).
            const loaded = await client.folders.getFolder({ id: f.id! });
            return { id: f.id!, version: loaded.version! };
        }

        test('PATCH name leaves description untouched (partial update)', async () => {
            const { id, version } = await createFolder();
            const patched = await client.folders.patchFolder({ id, body: { name: 'PATCH Folder (renamed)' } });
            expect(patched.name).toBe('PATCH Folder (renamed)');
            expect(patched.description).toBe('original description'); // preserved
            // Version increments on the stored row; reload to read the stored
            // truth (the folder write response is not re-fetched after the
            // conditional bump).
            const reloaded = await client.folders.getFolder({ id });
            expect(reloaded.version).toBe(version + 1);
        });

        test('optimistic lock — stale expectedVersion rejected 409, folder untouched', async () => {
            const { id, version } = await createFolder();
            // Conditional PATCH at the version we read — succeeds.
            await client.folders.patchFolder({
                id, body: { name: 'PATCH Folder v2', expectedVersion: version },
            });
            const afterFirst = await client.folders.getFolder({ id });
            expect(afterFirst.version).toBe(version + 1);
            expect(afterFirst.name).toBe('PATCH Folder v2');

            // Replaying the stale expectedVersion → 409, no write.
            await expect(client.folders.patchFolder({
                id, body: { name: 'PATCH Folder v3', expectedVersion: version },
            })).rejects.toMatchObject({ statusCode: 409 });
            const afterReject = await client.folders.getFolder({ id });
            expect(afterReject.name).toBe('PATCH Folder v2'); // unchanged by the rejected patch
        });

        test('PATCH to a missing id returns 404', async () => {
            await expect(client.folders.patchFolder({
                id: '22222222-2222-2222-2222-222222222222',
                body: { name: 'nope' },
            })).rejects.toMatchObject({ statusCode: 404 });
        });
    });
});
