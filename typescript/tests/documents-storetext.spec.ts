/**
 * documents-storetext.spec.ts — the text-retention contract.
 *
 * storeText is a FILE-upload-time retention choice, fixed at ingest:
 *   • default (true): the extracted text is retained — retrievable via
 *     GET /{id}/text and usable by POST /{id}/ask.
 *   • false: the extracted text is DISCARDED once indexing completes —
 *     search results and the original-file download keep working, but
 *     /text returns 404 and /ask returns 409.
 *   • text-ingested documents always retain their body (the body IS the
 *     document) — the flag is not part of the text-ingest contract.
 *   • immutable after ingest: a PATCH naming storeText is rejected (400).
 *
 * NOTE: the SDK (0.33+) types `storeText` on the file-upload request, so the
 * explicit-false upload rides the typed `client.documents.uploadDocument` call.
 * The PATCH-immutability check stays a raw fetch on purpose — the field is not
 * on the patch type, so the test asserts the WIRE contract (a 400) directly.
 *
 * DEPLOY GATING: this spec goes green with the platform deploy that ships
 * the storeText semantics. Against a PRE-deploy API, THREE of the four
 * tests fail (expected — do not mis-triage): the default-retention test's
 * `storeText === true` (old servers persist false for every file doc), the
 * explicit-false discard (old servers ignore the field and retain), and
 * the PATCH-immutability 400 (old servers accept storeText patches).
 */
import * as fs from 'fs';
import { client } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup } from '../src/helpers';
import { SAMPLE_PDF_PATH, SAMPLE_PDF_KNOWN_PHRASE } from '../src/fixtures';

const BASE_URL = process.env.VECTROS_API_BASE_URL!;
const API_KEY = process.env.VECTROS_API_KEY!;

async function putPdf(uploadUrl: string): Promise<void> {
    const bytes = fs.readFileSync(SAMPLE_PDF_PATH);
    const putResp = await fetch(uploadUrl, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': 'application/pdf' },
    });
    expect(putResp.status).toBe(200);
}

/**
 * The post-index discard rides an async stream event AFTER the document
 * reports INDEXED — poll /text until it 404s rather than asserting once.
 */
async function pollUntilTextGone(docId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await client.documents.getDocumentText({ id: docId });
        } catch (err) {
            if ((err as { statusCode?: number }).statusCode === 404) return;
            throw err;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `document ${docId} still serves /text after ${timeoutMs}ms — the storeText=false ` +
                'post-index discard did not run (expected until the platform deploy that ships it)',
            );
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
}

describe('documents (storeText retention contract)', () => {
    let testStartedAt: string;
    const docIds: string[] = [];

    beforeAll(() => {
        testStartedAt = new Date().toISOString();
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
    });

    test('file upload DEFAULT retains extracted text — /text serves it', async () => {
        const upload = await client.documents.uploadDocument({
            fileName: 'storetext-default.pdf',
            fileType: 'application/pdf',
            indexMode: 'TEXT',
        });
        docIds.push(upload.id!);
        await putPdf(upload.uploadUrl!);
        await pollUntilIndexed(upload.id!, 'document', 120_000);

        const text = await client.documents.getDocumentText({ id: upload.id! });
        expect(text.text).toContain(SAMPLE_PDF_KNOWN_PHRASE);

        const doc = await client.documents.getDocument({ id: upload.id! });
        expect(doc.storeText).toBe(true);
    });

    test('file upload storeText=false: indexed + downloadable, text discarded — /text 404, /ask 409', async () => {
        const upload = await client.documents.uploadDocument({
            fileName: 'storetext-false.pdf',
            fileType: 'application/pdf',
            indexMode: 'TEXT',
            storeText: false,
        });
        const id = upload.id!;
        docIds.push(id);
        await putPdf(upload.uploadUrl!);
        await pollUntilIndexed(id, 'document', 120_000);

        // The retention choice persisted.
        const doc = await client.documents.getDocument({ id });
        expect(doc.storeText).toBe(false);

        // Search is unaffected — the index was built before the discard.
        await pollUntilSearchable(SAMPLE_PDF_KNOWN_PHRASE, id, 15_000, 'TEXT', testStartedAt);

        // The extracted text is discarded once indexing completes (async after INDEXED).
        await pollUntilTextGone(id, 60_000);

        // The original file is still downloadable — only the extracted text is gone.
        const dl = await client.documents.getDocumentDownloadUrl({ id });
        expect(dl.downloadUrl).toBeTruthy();
        const dlResp = await fetch(dl.downloadUrl!);
        expect(dlResp.status).toBe(200);

        // /ask rejects honestly — there is no retained text to interrogate.
        await expect(client.inference.documentAsk({
            id,
            prompt: 'Summarize this document.',
            maxTokens: 16,
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    test('text ingest always retains its body — no flag needed', async () => {
        const doc = await client.documents.ingestDocument({ body: {
            title: 'Always Retained ' + uniqueTag(),
            text: 'Text-ingested bodies are the document itself and are always retrievable.',
            indexMode: 'TEXT',
        } });
        docIds.push(doc.id!);
        await pollUntilIndexed(doc.id!, 'document');

        const text = await client.documents.getDocumentText({ id: doc.id! });
        expect(text.text).toContain('always retrievable');

        const meta = await client.documents.getDocument({ id: doc.id! });
        expect(meta.storeText).toBe(true);
    });

    test('storeText is immutable after ingest — PATCH naming it is rejected', async () => {
        const doc = await client.documents.ingestDocument({ body: {
            title: 'Immutable Retention ' + uniqueTag(),
            text: 'Retention is decided at ingest.',
            indexMode: 'NONE',
        } });
        docIds.push(doc.id!);

        // Raw fetch: stable across SDK pins (newer SDKs drop the field from the
        // patch type entirely, older ones would forward it — either way the WIRE
        // contract is what rejects).
        const patchResp = await fetch(`${BASE_URL}/v1/documents/${doc.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ storeText: false }),
        });
        expect(patchResp.status).toBe(400);
    });
});
