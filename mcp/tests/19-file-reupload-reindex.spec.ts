import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

/**
 * File-mode RE-UPLOAD → re-extract → re-index smoke (#543/#544).
 *
 * The one curation surface unit tests can only MOCK: upload a file-backed
 * document, then re-upload a DIFFERENT file under the SAME externalId
 * (upsert:true), and confirm the backend re-extracts and RE-INDEXES the new
 * file's content — SAME document id, new text searchable, old text gone.
 * Exercises the live S3-upload → async extraction → re-index leg end-to-end
 * against staging (the leg that shipped to prod 2.4.0 without a live smoke).
 */

const UNIQUE = `reupload-${Date.now()}-${process.pid}`;
const EXTERNAL_ID = `mcp-reupload-smoke-${UNIQUE}`;
// Distinctive single alnum tokens so a keyword (BM25) query pins THIS doc.
const OLD_MARKER = `REUPLOADOLD${UNIQUE}`.replace(/-/g, '');
const NEW_MARKER = `REUPLOADNEW${UNIQUE}`.replace(/-/g, '');

const POLL_MS = 3000;
const INDEX_TRIES = 50; // ~150s ceiling for async extraction + index
const SEARCH_TRIES = 15; // ~45s for search visibility to catch up to INDEXED

type Body = Record<string, unknown>;

async function pollIndexed(client: any, documentId: string): Promise<Body> {
  for (let i = 0; i < INDEX_TRIES; i++) {
    const body = parse(
      await client.callTool({ name: 'document_get', arguments: { documentId } }),
    ) as Body;
    if (body.indexStatus === 'INDEXED') return body;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`document ${documentId} never reached INDEXED in ${(POLL_MS * INDEX_TRIES) / 1000}s`);
}

async function searchDocIds(client: any, query: string): Promise<string[]> {
  const body = parse(
    await client.callTool({ name: 'hybrid_search', arguments: { query, mode: 'TEXT', limit: 10 } }),
  ) as { results?: Array<{ documentId?: string }> };
  return (body.results ?? []).map((h) => h.documentId).filter((x): x is string => Boolean(x));
}

/** Poll search until THIS doc's presence for `query` equals `want` (search lags INDEXED). */
async function searchSettles(
  client: any,
  query: string,
  docId: string,
  want: boolean,
  tries = SEARCH_TRIES,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const ids = await searchDocIds(client, query);
    if (ids.includes(docId) === want) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

test('file re-upload re-extracts + re-indexes the new file (same id, old content gone)', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const oldFile = join(tmpdir(), `${UNIQUE}-old.txt`);
  const newFile = join(tmpdir(), `${UNIQUE}-new.txt`);
  await writeFile(oldFile, `Original file body. Marker ${OLD_MARKER}. Lorem ipsum dolor.`);
  await writeFile(newFile, `Replacement file body. Marker ${NEW_MARKER}. Sit amet consectetur.`);

  const { client, close } = await spawnServer({ VECTROS_MCP_INGEST_ROOT: tmpdir() });
  let docId: string | undefined;
  try {
    // 1) Ingest the ORIGINAL file.
    const first = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `Reupload smoke ${UNIQUE}`,
          filePath: oldFile,
          externalId: EXTERNAL_ID,
          indexMode: 'HYBRID',
        },
      }),
    ) as Body;
    docId = first.id as string;
    assert.ok(docId, 'first ingest returns a document id');
    assert.equal(first.indexStatus, 'PENDING_INDEX', 'first ingest is accepted async (PENDING_INDEX)');

    // 2) Wait for INDEXED; the OLD marker must be searchable for THIS doc.
    await pollIndexed(client, docId);
    assert.ok(
      await searchSettles(client, OLD_MARKER, docId, true),
      `old marker ${OLD_MARKER} should be searchable for the doc after first index`,
    );

    // 3) Re-upload a DIFFERENT file under the SAME externalId (the curation replace path).
    const second = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `Reupload smoke ${UNIQUE}`,
          filePath: newFile,
          externalId: EXTERNAL_ID,
          upsert: true,
          indexMode: 'HYBRID',
        },
      }),
    ) as Body;

    // 4) SAME document id — a re-index of the existing doc, NOT a duplicate.
    assert.equal(second.id, docId, 're-upload targets the SAME document id (no duplicate)');

    // 5) Re-index completes: NEW content searchable, OLD content gone for this doc.
    // NOTE: indexStatus can transiently read INDEXED from the FIRST index while the
    // re-extraction is still in flight, so pollIndexed can't bound this leg — give the
    // search settles the full async-extraction budget (INDEX_TRIES) instead.
    assert.ok(
      await searchSettles(client, NEW_MARKER, docId, true, INDEX_TRIES),
      `new marker ${NEW_MARKER} should be searchable after re-upload + re-index`,
    );
    assert.ok(
      await searchSettles(client, OLD_MARKER, docId, false),
      `old marker ${OLD_MARKER} must NO LONGER match the doc after re-index`,
    );
  } finally {
    if (docId) {
      await client
        .callTool({ name: 'document_delete', arguments: { documentId: docId } })
        .catch(() => {});
    }
    await close();
    await unlink(oldFile).catch(() => {});
    await unlink(newFile).catch(() => {});
  }
});
