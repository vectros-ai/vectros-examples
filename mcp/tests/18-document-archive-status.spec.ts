import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

/**
 * Document archive-status smoke — the soft-retract / restore round-trip via
 * `document_update`:
 *   document_ingest → document_get (status ACTIVE + indexStatus present) →
 *   document_update status:ARCHIVED → document_get (ARCHIVED) →
 *   document_update with a bad status (rejected client-side, no API call) →
 *   document_update status:ACTIVE (restore) → document_get (ACTIVE) →
 *   document_delete.
 *
 * Asserts the TOOL contract: `status` is sent and surfaced on read alongside
 * the read-only `indexStatus`, and the enum is validated strictly. Whether an
 * archived document is pulled from search is backend behavior (and eventually
 * consistent), so no search assertion here.
 *
 * Skips cleanly only when the key is unset or document writes are forbidden
 * (scope) — never early-returns to mask a real failure.
 */

const BASE = (process.env.VECTROS_API_BASE_URL ?? 'https://api.vectros.ai').replace(/\/$/, '');
const KEY = process.env.VECTROS_API_KEY;

async function rawDelete(path: string): Promise<void> {
  await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` },
  }).catch(() => {});
}

test('document archive → restore round-trip via document_update status', async (t) => {
  if (!KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  const { client, close } = await spawnServer();
  let docId: string | undefined;
  try {
    // INGEST a throwaway document.
    const ingestRes = await client.callTool({
      name: 'document_ingest',
      arguments: { title: 'MCP smoke — archive-status doc', text: 'A document for the archive-status smoke.' },
    });
    if (ingestRes.isError) {
      t.skip(`cannot ingest a document (key scope?): ${JSON.stringify(ingestRes)}`);
      return;
    }
    docId = parse(ingestRes).id as string;
    assert.ok(docId, 'document_ingest returned an id');

    // Fresh document reads back ACTIVE, with the processing axis alongside.
    const freshRes = await client.callTool({ name: 'document_get', arguments: { documentId: docId } });
    assert.ok(!freshRes.isError, `document_get failed: ${JSON.stringify(freshRes)}`);
    const fresh = parse(freshRes);
    assert.equal(fresh.status, 'ACTIVE', 'a fresh document is ACTIVE by default');
    assert.ok(typeof fresh.indexStatus === 'string', 'indexStatus surfaced on read (processing axis)');

    // ARCHIVE — soft-retract. Status applied; title preserved (merge-patch).
    const archiveRes = await client.callTool({
      name: 'document_update',
      arguments: { documentId: docId, status: 'ARCHIVED' },
    });
    assert.ok(!archiveRes.isError, `archive update failed: ${JSON.stringify(archiveRes)}`);
    const archived = parse(archiveRes);
    assert.equal(archived.status, 'ARCHIVED', 'update response reflects the archive');
    assert.equal(archived.title, 'MCP smoke — archive-status doc', 'title preserved across a status-only update');

    // Read the archived doc back WITH text: metadata must show ARCHIVED, and the
    // text path must stay graceful — either the stored text or a clean
    // textAvailable:false flag, never a tool error.
    const gotArchivedRes = await client.callTool({
      name: 'document_get',
      arguments: { documentId: docId, includeText: true },
    });
    assert.ok(!gotArchivedRes.isError, `document_get on archived doc failed: ${JSON.stringify(gotArchivedRes)}`);
    const gotArchived = parse(gotArchivedRes);
    assert.equal(gotArchived.status, 'ARCHIVED', 'archive persisted — read shows ARCHIVED');
    assert.ok(
      gotArchived.textAvailable === false || typeof gotArchived.text === 'string',
      `archived + includeText degrades gracefully, got: ${JSON.stringify({
        textAvailable: gotArchived.textAvailable,
        hasText: typeof gotArchived.text,
      })}`,
    );

    // A value outside the enum is rejected by the tool's strict validation.
    const badStatus = await client.callTool({
      name: 'document_update',
      arguments: { documentId: docId, status: 'DELETED' },
    });
    assert.equal(badStatus.isError, true, 'a status outside ACTIVE/ARCHIVED is rejected');

    // RESTORE — back to ACTIVE.
    const restoreRes = await client.callTool({
      name: 'document_update',
      arguments: { documentId: docId, status: 'ACTIVE' },
    });
    assert.ok(!restoreRes.isError, `restore update failed: ${JSON.stringify(restoreRes)}`);
    assert.equal(parse(restoreRes).status, 'ACTIVE', 'update response reflects the restore');

    const gotRestoredRes = await client.callTool({ name: 'document_get', arguments: { documentId: docId } });
    assert.ok(!gotRestoredRes.isError, `document_get after restore failed: ${JSON.stringify(gotRestoredRes)}`);
    assert.equal(parse(gotRestoredRes).status, 'ACTIVE', 'restore persisted — read shows ACTIVE');

    // DELETE (cleanup).
    const delRes = await client.callTool({ name: 'document_delete', arguments: { documentId: docId } });
    assert.ok(!delRes.isError, `cleanup delete failed: ${JSON.stringify(delRes)}`);
    assert.equal(parse(delRes).deleted, true);
    docId = undefined;
  } finally {
    await close();
    // Best-effort teardown if a step failed before the explicit delete.
    if (docId) await rawDelete(`/v1/documents/${docId}`);
  }
});
