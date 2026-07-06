/**
 * cross-context-isolation.spec.ts — end-to-end proof that an app context is a
 * fail-closed data partition within a single tenant.
 *
 * Each test is SYMMETRIC: it creates a sibling object in BOTH contexts and
 * asserts each confined caller sees ONLY its own — context A sees A's object
 * and NOT B's, context B sees B's object and NOT A's — on every read path:
 * get-by-id (uniform 404 across the partition, no existence probe), equality
 * lookup (empty), list (excluded), and search (excluded).
 *
 * The symmetry matters: a one-sided test ("B cannot see A's object") would pass
 * vacuously if B's caller were silently broken or over-confined (seeing nothing
 * for anyone). Proving each caller DOES see its own object — and is therefore a
 * live, correctly-confined caller — is what makes the negative decisive.
 *
 * This is the highest-value isolation seam for sensitive data: both contexts
 * live in one tenant, so the only thing keeping their data apart is the context
 * partition itself, exercised here over the real wire (gateway + authorizer
 * context derivation + finder partition clause) rather than against mocks.
 *
 * Coverage: records · documents · folders · schemas. Two confined `ssk_*`
 * clients (one per context) are provisioned in beforeAll; see
 * ../src/cross-context.ts for how a caller is confined to a context.
 */
import {
    provisionTwoContexts,
    TwoContextFixture,
    ContextHandle,
} from '../src/cross-context';
import { uniqueTag } from '../src/helpers';

/** Asserts a promise rejects with the given HTTP status. */
async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
    await expect(p).rejects.toMatchObject({ statusCode: status });
}

// These tests provision two app contexts under one tenant, which requires the
// tenant id (the scoped-key mint endpoint operates on a specific tenant). When
// it isn't set, skip the whole suite rather than fail — mirrors the optional
// second-key / scoped-key examples elsewhere.
const describeIfTenant = process.env.VECTROS_LIVE_TENANT_ID ? describe : describe.skip;

describeIfTenant('cross-context data isolation', () => {
    let fx: TwoContextFixture;

    beforeAll(async () => {
        fx = await provisionTwoContexts();
    }, 60_000);

    afterAll(async () => {
        if (fx) await fx.teardown();
    }, 60_000);

    // =======================================================================
    // Records — symmetric
    // =======================================================================
    test('each context sees only its OWN record on every read path', async () => {
        const { ctxA, ctxB } = fx;
        const type = `xctx_rec_${uniqueTag()}`.replace(/-/g, '_');
        const mrnA = `MRN-A-${uniqueTag()}`;
        const mrnB = `MRN-B-${uniqueTag()}`;

        // Schemas are themselves context-scoped — each context defines its own.
        const recA = await createRecord(ctxA, type, mrnA);
        const recB = await createRecord(ctxB, type, mrnB);

        // ctxA sees A, never B.
        expect((await ctxA.api.records.getRecord({ id: recA })).id).toBe(recA);
        await expectStatus(ctxA.api.records.getRecord({ id: recB }), 404);
        expect(await lookupRecordIds(ctxA, type, 'mrn', mrnA)).toEqual([recA]);
        expect(await lookupRecordIds(ctxA, type, 'mrn', mrnB)).toEqual([]);
        expect(await listRecordIds(ctxA, type)).toContain(recA);
        expect(await listRecordIds(ctxA, type)).not.toContain(recB);

        // ctxB sees B, never A.
        expect((await ctxB.api.records.getRecord({ id: recB })).id).toBe(recB);
        await expectStatus(ctxB.api.records.getRecord({ id: recA }), 404);
        expect(await lookupRecordIds(ctxB, type, 'mrn', mrnB)).toEqual([recB]);
        expect(await lookupRecordIds(ctxB, type, 'mrn', mrnA)).toEqual([]);
        expect(await listRecordIds(ctxB, type)).toContain(recB);
        expect(await listRecordIds(ctxB, type)).not.toContain(recA);

        // Mutate isolation: neither context can DELETE the other's record. The
        // confined keys hold records:d (see CONTEXT_KEY_SCOPES), so a 404 here is
        // the context partition, not a missing scope. Each object survives the
        // cross-context attempt; then each context CAN delete its OWN record.
        await expectStatus(ctxB.api.records.deleteRecord({ id: recA }), 404);
        await expectStatus(ctxA.api.records.deleteRecord({ id: recB }), 404);
        expect((await ctxA.api.records.getRecord({ id: recA })).id).toBe(recA);
        expect((await ctxB.api.records.getRecord({ id: recB })).id).toBe(recB);
        // ...and each context CAN delete its OWN (symmetric — proves both delete routes live).
        await ctxA.api.records.deleteRecord({ id: recA });
        await expectStatus(ctxA.api.records.getRecord({ id: recA }), 404);
        await ctxB.api.records.deleteRecord({ id: recB });
        await expectStatus(ctxB.api.records.getRecord({ id: recB }), 404);
    }, 60_000);

    // =======================================================================
    // Documents — symmetric, incl. search
    // =======================================================================
    test('each context sees only its OWN document (incl. search)', async () => {
        const { ctxA, ctxB } = fx;
        const type = `xctx_doc_${uniqueTag()}`.replace(/-/g, '_');
        const poA = `PO-A-${uniqueTag()}`;
        const poB = `PO-B-${uniqueTag()}`;
        const markerA = `XCTXMARKERA_${uniqueTag()}`.replace(/-/g, '_');
        const markerB = `XCTXMARKERB_${uniqueTag()}`.replace(/-/g, '_');
        const startedAt = new Date().toISOString();

        const docA = await createDoc(ctxA, type, poA, markerA);
        const docB = await createDoc(ctxB, type, poB, markerB);
        await pollUntilIndexedIn(ctxA, docA);
        await pollUntilIndexedIn(ctxB, docB);

        // by-id + lookup.
        expect((await ctxA.api.documents.getDocument({ id: docA })).id).toBe(docA);
        await expectStatus(ctxA.api.documents.getDocument({ id: docB }), 404);
        expect(await lookupDocIds(ctxA, type, 'po_number', poA)).toContain(docA);
        expect(await lookupDocIds(ctxA, type, 'po_number', poB)).toEqual([]);

        expect((await ctxB.api.documents.getDocument({ id: docB })).id).toBe(docB);
        await expectStatus(ctxB.api.documents.getDocument({ id: docA }), 404);
        expect(await lookupDocIds(ctxB, type, 'po_number', poB)).toContain(docB);
        expect(await lookupDocIds(ctxB, type, 'po_number', poA)).toEqual([]);

        // search — each context finds its own marker; the partition keeps the
        // sibling's document out of the result set. The positive control (each
        // caller DOES surface its own doc) proves search is live for both.
        expect(await searchDocIds(ctxA, markerA, startedAt)).toContain(docA);
        expect(await searchDocIds(ctxA, markerB, startedAt)).not.toContain(docB);
        expect(await searchDocIds(ctxB, markerB, startedAt)).toContain(docB);
        expect(await searchDocIds(ctxB, markerA, startedAt)).not.toContain(docA);

        // Mutate isolation: neither context can DELETE the other's document. Each
        // survives the cross-context attempt; then each context deletes its OWN.
        await expectStatus(ctxB.api.documents.deleteDocument({ id: docA }), 404);
        await expectStatus(ctxA.api.documents.deleteDocument({ id: docB }), 404);
        expect((await ctxA.api.documents.getDocument({ id: docA })).id).toBe(docA);
        expect((await ctxB.api.documents.getDocument({ id: docB })).id).toBe(docB);
        // ...and each context CAN delete its OWN (symmetric — proves both delete routes live).
        await ctxA.api.documents.deleteDocument({ id: docA });
        await expectStatus(ctxA.api.documents.getDocument({ id: docA }), 404);
        await ctxB.api.documents.deleteDocument({ id: docB });
        await expectStatus(ctxB.api.documents.getDocument({ id: docB }), 404);
    }, 120_000);

    // =======================================================================
    // Folders — symmetric
    // =======================================================================
    test('each context sees only its OWN folder, and cannot parent across the partition', async () => {
        const { ctxA, ctxB } = fx;
        const folderA = (await ctxA.api.folders.createFolder({ body: { name: `Folder A ${uniqueTag()}` } })).id!;
        const folderB = (await ctxB.api.folders.createFolder({ body: { name: `Folder B ${uniqueTag()}` } })).id!;

        expect((await ctxA.api.folders.getFolder({ id: folderA })).id).toBe(folderA);
        await expectStatus(ctxA.api.folders.getFolder({ id: folderB }), 404);
        expect(await listFolderIds(ctxA)).toContain(folderA);
        expect(await listFolderIds(ctxA)).not.toContain(folderB);

        expect((await ctxB.api.folders.getFolder({ id: folderB })).id).toBe(folderB);
        await expectStatus(ctxB.api.folders.getFolder({ id: folderA }), 404);
        expect(await listFolderIds(ctxB)).toContain(folderB);
        expect(await listFolderIds(ctxB)).not.toContain(folderA);

        // Neither context can reuse the other's folder as a parent — the parent
        // resolves only within the caller's own context, so it is not found.
        await expectStatus(ctxB.api.folders.createFolder({ body: { name: 'Child', parentFolderId: folderA } }), 400);
        await expectStatus(ctxA.api.folders.createFolder({ body: { name: 'Child', parentFolderId: folderB } }), 400);
    }, 60_000);

    // =======================================================================
    // Schemas — symmetric
    // =======================================================================
    test('each context sees only its OWN schema on every read path', async () => {
        const { ctxA, ctxB } = fx;
        const typeA = `xctx_sch_a_${uniqueTag()}`.replace(/-/g, '_');
        const typeB = `xctx_sch_b_${uniqueTag()}`.replace(/-/g, '_');
        const schemaA = await createSchema(ctxA, typeA);
        const schemaB = await createSchema(ctxB, typeB);

        // by-id.
        expect((await ctxA.api.schemas.getSchema({ id: schemaA })).id).toBe(schemaA);
        await expectStatus(ctxA.api.schemas.getSchema({ id: schemaB }), 404);
        expect((await ctxB.api.schemas.getSchema({ id: schemaB })).id).toBe(schemaB);
        await expectStatus(ctxB.api.schemas.getSchema({ id: schemaA }), 404);

        // recordType resolution: each context resolves its own type, returns
        // empty for the sibling's type, and must not echo it back (no probe).
        const resolvedAown = await ctxA.api.schemas.listSchemas({ recordType: typeA, limit: 100 });
        expect((resolvedAown.data ?? []).map((s) => s.id)).toContain(schemaA);
        const resolvedAcross = await ctxA.api.schemas.listSchemas({ recordType: typeB, limit: 100 });
        expect(resolvedAcross.data ?? []).toHaveLength(0);
        expect(JSON.stringify(resolvedAcross)).not.toContain(typeB);

        const resolvedBown = await ctxB.api.schemas.listSchemas({ recordType: typeB, limit: 100 });
        expect((resolvedBown.data ?? []).map((s) => s.id)).toContain(schemaB);
        const resolvedBcross = await ctxB.api.schemas.listSchemas({ recordType: typeA, limit: 100 });
        expect(resolvedBcross.data ?? []).toHaveLength(0);
        expect(JSON.stringify(resolvedBcross)).not.toContain(typeA);
    }, 60_000);
});

// ---------------------------------------------------------------------------
// Per-resource provisioning + read helpers (operate through a context's
// confined client, so every call is partitioned to that context).
// ---------------------------------------------------------------------------

async function createRecord(ctx: ContextHandle, type: string, mrn: string): Promise<string> {
    const schema = await ctx.api.schemas.createSchema({ body: {
        typeName: type,
        displayName: 'Cross-context Record Schema',
        indexMode: 'NONE',
        allowedSurfaces: ['record'],
        fields: [{ fieldId: 'mrn', fieldType: 'string', required: true }],
        lookupFields: [{ fieldName: 'mrn', unique: true }],
    } });
    const rec = await ctx.api.records.createRecord({ body: { typeName: type, schemaId: schema.id!, payload: { mrn } } });
    return rec.id!;
}

async function lookupRecordIds(ctx: ContextHandle, type: string, field: string, value: string): Promise<string[]> {
    const res = await ctx.api.records.lookupRecords({ type, field, value });
    return (res.data ?? []).map((r) => r.id!).filter(Boolean);
}

async function listRecordIds(ctx: ContextHandle, type: string): Promise<string[]> {
    const res = await ctx.api.records.listRecords({ type, limit: 100 });
    return (res.data ?? []).map((r) => r.id!).filter(Boolean);
}

async function createDoc(ctx: ContextHandle, type: string, po: string, marker: string): Promise<string> {
    const schema = await ctx.api.schemas.createSchema({ body: {
        typeName: type,
        displayName: 'Cross-context Document Schema',
        indexMode: 'TEXT',
        allowedSurfaces: ['document'],
        fields: [{ fieldId: 'po_number', fieldType: 'string' }],
        lookupFields: [{ fieldName: 'po_number', unique: false }],
    } });
    const doc = await ctx.api.documents.ingestDocument({ body: {
        title: `Cross-context Doc ${po}`,
        schemaId: schema.id!,
        text: `Confidential note ${marker} for purchase order ${po}.`,
        indexMode: 'TEXT',
        payload: { po_number: po },
    } });
    return doc.id!;
}

async function lookupDocIds(ctx: ContextHandle, type: string, field: string, value: string): Promise<string[]> {
    const res = await ctx.api.documents.lookupDocuments({ type, field, value });
    return (res.data ?? []).map((d) => d.id!).filter(Boolean);
}

async function searchDocIds(ctx: ContextHandle, query: string, createdAfter: string): Promise<string[]> {
    const res = await ctx.api.search.content({ query, mode: 'TEXT', limit: 100, createdAfter });
    return (res.results ?? []).map((r) => r.documentId!).filter(Boolean);
}

async function listFolderIds(ctx: ContextHandle): Promise<string[]> {
    const res = await ctx.api.folders.listFolders({ limit: 100 });
    return (res.data ?? []).map((f) => f.id!).filter(Boolean);
}

async function createSchema(ctx: ContextHandle, type: string): Promise<string> {
    const schema = await ctx.api.schemas.createSchema({ body: {
        typeName: type,
        displayName: 'Cross-context Schema',
        indexMode: 'NONE',
        allowedSurfaces: ['record'],
        fields: [{ fieldId: 'name', fieldType: 'string' }],
    } });
    return schema.id!;
}

/**
 * Polls a confined client until its document reaches INDEXED — the context
 * analogue of the shared pollUntilIndexed (which is bound to the root client).
 */
async function pollUntilIndexedIn(ctx: ContextHandle, docId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let status: string | undefined;
    while (Date.now() < deadline) {
        // indexStatus since the 2.4.0 status split; `status` fallback for pre-split envs.
        const doc = await ctx.api.documents.getDocument({ id: docId });
        status = doc.indexStatus ?? doc.status;
        if (status === 'INDEXED') return;
        if (status === 'FAILED') throw new Error(`document ${docId} reached FAILED during indexing`);
        await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`document ${docId} did not reach INDEXED within ${timeoutMs}ms (last: ${status})`);
}
