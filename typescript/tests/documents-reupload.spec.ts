/**
 * documents-reupload.spec.ts — regression gate: a file RE-upload
 * (re-initiating an upload with an existing externalId) must succeed WITHOUT
 * re-sending `indexMode` — the existing document already carries one and the
 * re-upload inherits it.
 *
 * Step 2 mirrors the data-plane app's replace-a-file call EXACTLY
 * (DocumentDetailPage's replace mutation): `{ fileName, fileType, externalId }`
 * and nothing else — no indexMode, no upsert. The MCP path cannot gate this
 * bug — its `document_ingest` client-side-defaults untyped docs to HYBRID, so
 * it always sends `indexMode` and masks the omission. Hence this SDK-level
 * spec is the regression gate. (The `upsert:true` variant of the same inherit
 * is covered by the backend unit tests.)
 */
import { client, getScopedClient } from '../src/client';
import {
    uniqueTag,
    pollUntilIndexed,
    pollUntilSearchable,
    pollUntilSearchHitGone,
    sleep,
    tryCleanup,
    presignedUploadHeaders,
    expectReject,
} from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

describe('documents (re-upload inherits indexMode)', () => {
    let testStartedAt: string;
    const docIds: string[] = [];

    // Distinctive single alnum tokens so a TEXT (BM25) query pins THIS doc's
    // current content unambiguously across the replace.
    const unique = uniqueTag().replace(/-/g, '');
    const externalId = `reupload-${uniqueTag()}`;
    const OLD_MARKER = `REUPLOADOLD${unique}`;
    const NEW_MARKER = `REUPLOADNEW${unique}`;

    beforeAll(() => {
        testStartedAt = new Date().toISOString();
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
    });

    test('re-upload without indexMode succeeds: same id, inherited mode, new content indexed, old gone', async () => {
        // ---- 1) CREATE: initial upload declares indexMode (the app's create path).
        const first = await client.documents.uploadDocument({
            fileName: 'reupload-smoke.txt',
            fileType: 'text/plain',
            indexMode: 'HYBRID',
            externalId,
        });
        docIds.push(first.id!);
        expect(first.created).toBe(true);
        expect(first.uploadUrl).toMatch(/^https:\/\//);

        const putOld = await fetch(first.uploadUrl!, {
            method: 'PUT',
            body: `Original file body. Marker ${OLD_MARKER}. Lorem ipsum dolor.`,
            headers: { 'Content-Type': 'text/plain', ...presignedUploadHeaders(first) },
        });
        expect(putOld.status).toBe(200);

        await pollUntilIndexed(first.id!, 'document', 120_000);
        await pollUntilSearchable(OLD_MARKER, first.id!, 30_000, 'TEXT', testStartedAt);

        // ---- 2) RE-UPLOAD: the app's replace-file call, byte-for-byte — ONLY
        // fileName/fileType/externalId (no indexMode, no upsert). Regression
        // point: the backend must inherit the existing document's stored indexMode,
        // not reject with "'indexMode' is required".
        const second = await client.documents.uploadDocument({
            fileName: 'reupload-smoke.txt',
            fileType: 'text/plain',
            externalId,
        });
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        expect(second.uploadUrl).toMatch(/^https:\/\//);

        // ---- 3) PUT the replacement bytes → re-extract → re-index.
        const putNew = await fetch(second.uploadUrl!, {
            method: 'PUT',
            body: `Replacement file body. Marker ${NEW_MARKER}. Sit amet consectetur.`,
            headers: { 'Content-Type': 'text/plain', ...presignedUploadHeaders(second) },
        });
        expect(putNew.status).toBe(200);

        // The inherited (immutable) mode survives the replace.
        const loaded = await client.documents.getDocument({ id: first.id! });
        expect(loaded.indexMode).toBe('HYBRID');

        // ---- 4) NEW content searchable, OLD content gone — for THIS doc.
        // pollUntilSearchable owns the whole re-extract → re-index → visibility
        // window (the doc may transiently read INDEXED from the FIRST index while
        // the re-extraction is still in flight, so pollUntilIndexed can't bound it).
        await pollUntilSearchable(NEW_MARKER, first.id!, 120_000, 'TEXT', testStartedAt);
        await pollUntilSearchHitGone(OLD_MARKER, first.id!, 30_000, 'TEXT', testStartedAt);
    });

    // The `upsert: true` variant of the same inherit — the SDK shape for
    // "replace the file AND apply metadata in one call". Contract-level only
    // (the full PUT → re-index cycle is exercised by the gate test above).
    test('upsert re-upload without indexMode also inherits (same id, mode preserved)', async () => {
        const upsertExternalId = `reupload-upsert-${uniqueTag()}`;
        const first = await client.documents.uploadDocument({
            fileName: 'reupload-upsert-smoke.txt',
            fileType: 'text/plain',
            indexMode: 'HYBRID',
            externalId: upsertExternalId,
        });
        docIds.push(first.id!);
        expect(first.created).toBe(true);

        const second = await client.documents.uploadDocument({
            fileName: 'reupload-upsert-smoke.txt',
            fileType: 'text/plain',
            externalId: upsertExternalId,
            upsert: true,
            payload: { revision: 'two' },
        });
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);

        const loaded = await client.documents.getDocument({ id: first.id! });
        expect(loaded.indexMode).toBe('HYBRID');
        expect(loaded.payload).toMatchObject({ revision: 'two' });
    });

    // TYPED documents: the externalId lives in the type's namespace, so the
    // replace call re-sends the schemaId (as the app does) — and must inherit
    // the stored indexMode the same way. The schema deliberately declares NO
    // default index mode: a schema default would satisfy the resolver on its
    // own and mask a regression of the inherit ordering.
    test('typed re-upload (schemaId re-sent) without indexMode inherits the stored mode', async () => {
        const typeName = `smoke_reupload_doc_${uniqueTag().replace(/-/g, '_')}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName,
            displayName: 'Reupload smoke document type',
            allowedSurfaces: ['document'],
            fields: [{ fieldId: 'category', fieldType: 'string', required: false, filterable: true }],
        } });
        const typedExternalId = `reupload-typed-${uniqueTag()}`;
        let typedDocId: string | undefined;
        try {
            const first = await client.documents.uploadDocument({
                fileName: 'reupload-typed-smoke.txt',
                fileType: 'text/plain',
                indexMode: 'HYBRID',
                schemaId: schema.id!,
                externalId: typedExternalId,
                payload: { category: 'original' },
            });
            typedDocId = first.id;
            expect(first.created).toBe(true);

            const second = await client.documents.uploadDocument({
                fileName: 'reupload-typed-smoke.txt',
                fileType: 'text/plain',
                schemaId: schema.id!,
                externalId: typedExternalId,
            });
            expect(second.created).toBe(false);
            expect(second.id).toBe(first.id);

            const loaded = await client.documents.getDocument({ id: first.id! });
            expect(loaded.indexMode).toBe('HYBRID');
            expect(loaded.schemaId).toBe(schema.id);
        } finally {
            // Cleaned up here (not the shared afterAll): the schema can only
            // delete once its document is gone, so the order matters — and the
            // document delete settles asynchronously, so retry the schema
            // delete briefly rather than orphaning a smoke schema per run.
            if (typedDocId) {
                await tryCleanup(`delete typed doc ${typedDocId}`, () =>
                    client.documents.deleteDocument({ id: typedDocId! }));
            }
            await tryCleanup('delete reupload smoke schema', async () => {
                for (let attempt = 1; ; attempt++) {
                    try {
                        await client.schemas.deleteSchema({ id: schema.id! });
                        return;
                    } catch (err) {
                        if (attempt >= 5) throw err;
                        await sleep(2_000);
                    }
                }
            });
        }
    });
});

/**
 * A re-upload is an update to an existing document, so it requires the
 * `documents:u` scope — even against a document whose FIRST upload never
 * completed (no bytes ever landed for its externalId). This closes a prior
 * gap where that specific case could go through on `documents:c` alone,
 * since re-initiating an upload against an existing externalId is
 * "supplying an existing document's body" regardless of whether anything
 * was ever actually uploaded to it.
 */
describe('documents (re-upload always requires documents:u)', () => {
    let ownerUserId: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        ownerUserId = user.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: ownerUserId }));
    });

    test('re-initiating an upload against an existing externalId (first upload never completed) requires documents:u, not just documents:c', async () => {
        const externalId = `reupload-scope-${uniqueTag()}`;

        // First upload: mint the presigned URL but never PUT any bytes — the
        // externalId now identifies an existing document with no completed
        // upload behind it.
        const first = await client.documents.uploadDocument({
            fileName: 'reupload-scope-smoke.txt',
            fileType: 'text/plain',
            indexMode: 'HYBRID',
            userId: ownerUserId,
            externalId,
        });
        docIds.push(first.id!);
        expect(first.created).toBe(true);

        // A token holding ONLY documents:c, correlated to this document's own
        // owner, must still be refused — no bytes ever landed, but re-initiating
        // against an existing externalId is an update, not a create.
        const createOnly = (await client.auth.mintToken({
            scope: { allowedActions: ['documents:c'], dataScope: { userId: [ownerUserId] } },
        })) as MintedToken;
        const createOnlyClient = getScopedClient(createOnly.token);
        await expectReject(createOnlyClient.documents.uploadDocument({
            fileName: 'reupload-scope-smoke.txt',
            fileType: 'text/plain',
            externalId,
        }), 403);

        // The identical re-upload succeeds once the token also holds documents:u.
        const createAndUpdate = (await client.auth.mintToken({
            scope: { allowedActions: ['documents:c', 'documents:u'], dataScope: { userId: [ownerUserId] } },
        })) as MintedToken;
        const createAndUpdateClient = getScopedClient(createAndUpdate.token);
        const second = await createAndUpdateClient.documents.uploadDocument({
            fileName: 'reupload-scope-smoke.txt',
            fileType: 'text/plain',
            externalId,
        });
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        expect(second.uploadUrl).toMatch(/^https:\/\//);
    });
});
