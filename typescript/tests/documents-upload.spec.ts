/**
 * documents-upload.spec.ts — File upload presigned URL handshake. Most complex
 * flow and the most important documentation target. The three-step pattern
 * (request URL → PUT bytes → poll) is the one developers get wrong most often.
 */
import * as fs from 'fs';
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup } from '../src/helpers';
import { SAMPLE_PDF_PATH, SAMPLE_PDF_KNOWN_PHRASE, SAMPLE_PDF_SEMANTIC_PHRASE } from '../src/fixtures';

interface MintedToken { token: string; expiresAt: number; }

describe('documents (upload)', () => {
    let userId: string;
    let testStartedAt: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
    });

    // ANCHOR — the three-step presigned upload handshake. THIS test is the
    // documentation; if developers learn nothing else from the smoke suite,
    // they should learn this pattern.
    test('presigned upload handshake: request URL → PUT bytes → poll INDEXED', async () => {
        // Step 1: request a presigned URL
        const upload = await client.documents.uploadDocument({
            fileName: 'smoke-test-clinical-note.pdf',
            fileType: 'application/pdf',
            indexMode: 'HYBRID',
            userId,
            // Documents are typed surfaces carrying a free-form `payload`,
            // filterable by key via search `filters` (see the metadata-filter
            // test below).
            payload: {
                category: 'clinical-note',
                source: 'smoke-test',
            },
        });
        docIds.push(upload.id!);
        expect(upload.uploadUrl).toMatch(/^https:\/\//);
        // expiresAt is ISO-8601 UTC (Vectros uses LLM-friendly timestamps),
        // not epoch-seconds. Assert it parses to a future Date.
        expect(new Date(upload.expiresAt!).getTime()).toBeGreaterThan(Date.now());

        // Step 2: PUT raw bytes to the presigned URL — NO Authorization header
        const body = fs.readFileSync(SAMPLE_PDF_PATH);
        const putResp = await fetch(upload.uploadUrl!, {
            method: 'PUT',
            body,
            headers: { 'Content-Type': 'application/pdf' },
        });
        expect(putResp.status).toBe(200);

        // Step 3: poll until INDEXED (text extraction adds latency → 120s timeout)
        await pollUntilIndexed(upload.id!, 'document', 120_000);
        const loaded = await client.documents.getDocument({ id: upload.id! });
        expect(loaded.indexStatus).toBe('INDEXED');
        expect(loaded.fileType).toBe('application/pdf');
        expect(loaded.fileSize).toBeGreaterThan(0);
        expect(loaded.userId).toBe(userId);

        // Verify the indexed content is searchable. Bridge the residual
        // INDEXED→commit-visible window. createdAfter scopes results to this
        // run — orphan PDFs from prior smoke runs with the same KNOWN_PHRASE
        // can't push our just-uploaded doc off the result page.
        await pollUntilSearchable(SAMPLE_PDF_KNOWN_PHRASE, upload.id!, 10_000, 'TEXT', testStartedAt);
        const results = await client.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'TEXT',
            limit: 100,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === upload.id);
        expect(hit).toBeDefined();
    });

    test('search HYBRID — both scores > 0, contextText may be set if multi-chunk', async () => {
        // ANCHOR uploaded sample.pdf. Use the known-phrase to hit the doc
        // via both lanes (TEXT BM25 + SEMANTIC vector). Whether contextText
        // is populated depends on whether the extracted PDF is long enough
        // to produce multiple chunks — for sample.pdf it's typically not.
        const results = await client.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === docIds[0]);
        expect(hit).toBeDefined();
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBeGreaterThan(0);
        // contextText > chunkText assertion only valid when multi-chunk.
        // documents-text.spec carries the strict version on a long body.
    });

    test('search SEMANTIC — matches semantically related phrase', async () => {
        // SAMPLE_PDF_SEMANTIC_PHRASE is intentionally NOT a verbatim subset
        // of the PDF — exercises vector recall over BM25.
        const results = await client.search.content({
            query: SAMPLE_PDF_SEMANTIC_PHRASE,
            mode: 'SEMANTIC',
            limit: 20,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === docIds[0]);
        expect(hit).toBeDefined();
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBe(0);
    });

    test('search SEMANTIC — recalls the verbatim known phrase too (isolated)', async () => {
        // Isolated semantic-recall guard for the VERBATIM phrase. Without it,
        // verbatim recall is only ever exercised implicitly inside the HYBRID
        // "both scores > 0" test, which conflates "fusion works" with "this
        // phrase hits the vector leg". A short literal sub-phrase has weak
        // document-level cosine (~0.19 at 1024-dim), so it must clear the
        // semantic floor (minSimilarity 0.15) on its own. This is the canary
        // that catches a re-narrowing of recall — e.g. an embedding-dimension
        // cut that compresses the absolute scale, or a floor set too high.
        // textScore is 0 because this is SEMANTIC-only.
        const results = await client.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'SEMANTIC',
            limit: 20,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === docIds[0]);
        expect(hit).toBeDefined();
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBe(0);
    });

    test('metadata filter on file document', async () => {
        // ANCHOR doc has payload.category=clinical-note. Filter for that.
        const results = await client.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            filters: { category: 'clinical-note' },
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(docIds[0]);
        // Negative-case sanity: a category that nothing in this run has
        // returns 0 hits for the same query.
        const noMatch = await client.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            filters: { category: 'no-such-category-' + uniqueTag() },
        });
        const noIds = (noMatch.results ?? []).map((r) => r.documentId);
        expect(noIds).not.toContain(docIds[0]);
    });

    test('ownership filter via userId', async () => {
        // ANCHOR doc is owned by userId. A search filtered by ownerId=userId
        // must include it; a search with no userId filter behaves the same on
        // this tenant since the ANCHOR is the only PDF in the run.
        const results = await client.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            userId,
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(docIds[0]);
    });

    test('extracted text of a file-backed document stays retrievable (retention gate)', async () => {
        // File-backed docs keep BOTH the uploaded source and the extracted text
        // permanently — /text serves the extracted text (retained by default; see documents-storetext.spec.ts for the opt-out)
        // (which is a text-ingest concern). This is the read-contract gate for
        // the retention regression class: a reaped blob turns this into a
        // 404/500 long after INDEXED reported success.
        const resp = await client.documents.getDocumentText({ id: docIds[0] });
        expect(resp.id).toBe(docIds[0]);
        expect(resp.text).toContain(SAMPLE_PDF_KNOWN_PHRASE);
    });

    test('presigned download URL — fetch returns 200', async () => {
        // ANCHOR doc is a file-backed PDF. Round-trip via the SDK's typed
        // getDocumentDownloadUrl, then GET the presigned URL directly via
        // fetch to confirm it actually serves the file. Exercises both the
        // signed-URL minting path and the S3 GET permissions.
        const resp = await client.documents.getDocumentDownloadUrl({ id: docIds[0] });
        expect(resp.downloadUrl).toBeTruthy();
        expect(resp.id).toBe(docIds[0]);
        expect(resp.expires).toBeGreaterThan(Date.now());

        // SDK marks downloadUrl as optional (string | undefined) — non-null
        // assert after the toBeTruthy gate above so fetch() gets a string.
        const dl = await fetch(resp.downloadUrl!);
        expect(dl.status).toBe(200);
    });
});

/**
 * documents (upload — scope ownership). File uploads gained a `scopes` field —
 * closing a prior SDK gap where only text-ingest could declare
 * scope ownership. This block pins parity with text-ingest: a file uploaded with
 * `scopes` carries them on the document, and a scoped token confined to that scope
 * sees the file in search while one confined elsewhere does not.
 *
 * The upload-init response (FileUploadResponse) is minted BEFORE the bytes arrive
 * and does NOT carry `scopes` — so the echo is asserted on the document read
 * (`GET /v1/documents/{id}`), which is where scope ownership surfaces.
 */
describe('documents (upload — scope ownership)', () => {
    let inScopeOrgId: string;   // the org the file is scoped to
    let outScopeOrgId: string;  // a different org — its token must NOT see the file
    let testStartedAt: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        const inOrg = await client.identity.createEntity({ namespace: 'org', body: { externalId: uniqueTag(), name: 'Upload Scope In' } });
        inScopeOrgId = inOrg.id!;
        const outOrg = await client.identity.createEntity({ namespace: 'org', body: { externalId: uniqueTag(), name: 'Upload Scope Out' } });
        outScopeOrgId = outOrg.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete in-org', () => client.identity.deleteEntity({ namespace: 'org', id: inScopeOrgId }));
        await tryCleanup('delete out-org', () => client.identity.deleteEntity({ namespace: 'org', id: outScopeOrgId }));
    });

    test('uploaded file carries its scopes; in-scope token sees it in search, out-of-scope token does not', async () => {
        const orgScope = `org:${inScopeOrgId}`;

        // ── Upload with an org scope (the upload-scopes surface) ──────────────
        const upload = await client.documents.uploadDocument({
            fileName: 'smoke-scoped-upload.pdf',
            fileType: 'application/pdf',
            indexMode: 'HYBRID',
            // The scopes declaration — an `org:<id>` ownership edge on the
            // uploaded file, the file-upload analogue of text-ingest's scopes.
            scopes: [orgScope],
            payload: { category: 'scoped-upload' },
        });
        docIds.push(upload.id!);

        const body = fs.readFileSync(SAMPLE_PDF_PATH);
        const putResp = await fetch(upload.uploadUrl!, {
            method: 'PUT',
            body,
            headers: { 'Content-Type': 'application/pdf' },
        });
        expect(putResp.status).toBe(200);

        await pollUntilIndexed(upload.id!, 'document', 120_000);

        // ── The document echoes the scope ownership — the DIRECT proof that the
        // upload `scopes` field is wired end-to-end (the scopes contract). If upload
        // ignored `scopes`, this read-back is where it fails. ──────────────────
        const loaded = await client.documents.getDocument({ id: upload.id! });
        expect(loaded.scopes ?? []).toContain(orgScope);

        // ── In-scope token: dataScope bound to the org → SEES the file ────────
        // Strict dataScope (no null sentinel) requires the ownership scope to be
        // carried explicitly on the search call (see auth.spec's dataScope test).
        const inMint = (await client.auth.mintToken({
            scope: { allowedActions: ['documents:r', 'search:r'], dataScope: { 'scope:org': [inScopeOrgId] } },
        })) as MintedToken;
        const inScoped = getScopedClient(inMint.token);
        await pollUntilSearchable(SAMPLE_PDF_KNOWN_PHRASE, upload.id!, 30_000, 'TEXT', testStartedAt);
        const inResults = await inScoped.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'TEXT',
            limit: 100,
            createdAfter: testStartedAt,
            scope: orgScope,
        });
        expect((inResults.results ?? []).map((r) => r.documentId)).toContain(upload.id);

        // ── Out-of-scope token: bound to a DIFFERENT org → does NOT see it. This
        // is a generic scope-confinement backstop (it also holds for any org-owned
        // doc), NOT the primary scopes proof — that is the scopes echo + the positive
        // visibility above. ───────────────────────────────────────────────────
        const outMint = (await client.auth.mintToken({
            scope: { allowedActions: ['documents:r', 'search:r'], dataScope: { 'scope:org': [outScopeOrgId] } },
        })) as MintedToken;
        const outScoped = getScopedClient(outMint.token);
        const outResults = await outScoped.search.content({
            query: SAMPLE_PDF_KNOWN_PHRASE,
            mode: 'TEXT',
            limit: 100,
            createdAfter: testStartedAt,
            scope: `org:${outScopeOrgId}`,
        });
        expect((outResults.results ?? []).map((r) => r.documentId)).not.toContain(upload.id);
    }, 180_000);
});
