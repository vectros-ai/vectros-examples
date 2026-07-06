/**
 * documents-upload.spec.ts — File upload presigned URL handshake. Most complex
 * flow and the most important documentation target. The three-step pattern
 * (request URL → PUT bytes → poll) is the one developers get wrong most often.
 */
import * as fs from 'fs';
import { client } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup } from '../src/helpers';
import { SAMPLE_PDF_PATH, SAMPLE_PDF_KNOWN_PHRASE, SAMPLE_PDF_SEMANTIC_PHRASE } from '../src/fixtures';

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
