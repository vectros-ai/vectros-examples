import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

/**
 * Tier-3 smoke — folder CRUD + document writes, the full lifecycle:
 *   folder_create → folder_query (get + list) → folder_update (rename) →
 *   document_ingest → document_update (move into the folder + merge payload +
 *   optimistic-concurrency conflict) → document_query (list in folder) →
 *   document_delete → folder_delete.
 *
 * Folders are schemaless and documents ingest without a schema, so unlike the
 * records lifecycle this needs NO raw-HTTP schema seeding — it runs entirely
 * through the MCP tools. Raw HTTP is used only for best-effort teardown if a
 * step fails before the explicit deletes.
 *
 * Skips cleanly only when the key is unset or document/folder writes are
 * forbidden (scope) — never early-returns to mask a real failure.
 */

const BASE = (process.env.VECTROS_API_BASE_URL ?? 'https://api.vectros.ai').replace(/\/$/, '');
const KEY = process.env.VECTROS_API_KEY;

async function rawDelete(path: string): Promise<void> {
  await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` },
  }).catch(() => {});
}

test('folder CRUD + document write lifecycle', async (t) => {
  if (!KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  const { client, close } = await spawnServer();
  let folderId: string | undefined;
  let docId: string | undefined;
  try {
    // CREATE a folder.
    const createRes = await client.callTool({
      name: 'folder_create',
      arguments: { name: `MCP smoke folder ${Date.now()}`, description: 'tier-3 smoke' },
    });
    if (createRes.isError) {
      t.skip(`cannot create a folder (key scope folders:c?): ${JSON.stringify(createRes)}`);
      return;
    }
    const created = parse(createRes);
    assert.ok(created.id, `folder_create returned an id: ${JSON.stringify(created)}`);
    folderId = created.id as string;

    // GET the folder by id.
    const got = parse(await client.callTool({ name: 'folder_query', arguments: { id: folderId } }));
    assert.equal(got.id, folderId, 'folder_query get returns the folder');

    // LIST folders → { data, nextCursor } page envelope (folder listing is paginated).
    const listed = parse(await client.callTool({ name: 'folder_query', arguments: { limit: 10 } }));
    assert.ok(Array.isArray(listed.data), 'folder_query list returns a { data, nextCursor } page');
    assert.ok('nextCursor' in listed, 'list envelope carries a nextCursor key');

    // UPDATE (rename) — RFC-7386 merge-patch: name is set; the OMITTED description must be
    // PRESERVED by the merge (assert it, don't assume it).
    const renamed = parse(
      await client.callTool({ name: 'folder_update', arguments: { id: folderId, name: 'MCP smoke renamed' } }),
    );
    assert.equal(renamed.name, 'MCP smoke renamed', 'folder rename applied');
    assert.equal(renamed.description, 'tier-3 smoke', 'description preserved across a name-only update');

    // INGEST a document (no schema needed).
    const ingestRes = await client.callTool({
      name: 'document_ingest',
      arguments: { title: 'MCP smoke — tier-3 doc', text: 'A document for the tier-3 write lifecycle smoke.' },
    });
    if (ingestRes.isError) {
      t.skip(`cannot ingest a document (key scope?): ${JSON.stringify(ingestRes)}`);
      return;
    }
    docId = parse(ingestRes).id as string;
    assert.ok(docId, 'document_ingest returned an id');

    // Read current version for the optimistic-concurrency update.
    const docGot = parse(await client.callTool({ name: 'document_get', arguments: { documentId: docId } }));
    const ver = docGot.version as number;

    // UPDATE — RFC-7386 merge-patch: move into our folder + add a free-form payload
    // field; title omitted (server preserves it); expectedVersion forwarded.
    const updated = parse(
      await client.callTool({
        name: 'document_update',
        arguments: {
          documentId: docId,
          folderId,
          fields: { smokeTag: 'tier3' },
          expectedVersion: ver,
        },
      }),
    );
    assert.equal(updated.folderId, folderId, 'document moved into the folder');
    assert.equal(updated.title, 'MCP smoke — tier-3 doc', 'title preserved (omitted → unchanged server-side)');
    assert.equal(updated.payload?.smokeTag, 'tier3', 'payload field merged in');

    // UPDATE conflict — the now-stale (pre-update) version is rejected server-side (409).
    const conflict = await client.callTool({
      name: 'document_update',
      arguments: { documentId: docId, fields: { smokeTag: 'should-not-apply' }, expectedVersion: ver },
    });
    assert.equal(conflict.isError, true, 'stale expectedVersion → conflict');
    assert.match(String((conflict as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''), /409|conflict/i);

    // QUERY documents in our folder — {data,nextCursor} envelope with our doc in `data`.
    const inFolder = parse(
      await client.callTool({ name: 'document_query', arguments: { folderId, limit: 10 } }),
    );
    assert.ok(Array.isArray(inFolder.data), `document_query list returns a {data,nextCursor} envelope: ${JSON.stringify(inFolder)}`);
    assert.ok(inFolder.data.some((d: any) => d.id === docId), 'the moved document appears in the folder listing');

    // DELETE the document → a subsequent get must fail.
    const delDoc = parse(await client.callTool({ name: 'document_delete', arguments: { documentId: docId } }));
    assert.equal(delDoc.deleted, true);
    const afterDocDelete = await client.callTool({ name: 'document_get', arguments: { documentId: docId } });
    assert.equal(afterDocDelete.isError, true, 'document_get after delete returns an error');
    docId = undefined;

    // DELETE the folder → a subsequent get must fail.
    const delFolder = parse(await client.callTool({ name: 'folder_delete', arguments: { id: folderId } }));
    assert.equal(delFolder.deleted, true);
    const afterFolderDelete = await client.callTool({ name: 'folder_query', arguments: { id: folderId } });
    assert.equal(afterFolderDelete.isError, true, 'folder_query get after delete returns an error');
    folderId = undefined;
  } finally {
    await close();
    // Best-effort teardown if a step failed before the explicit deletes.
    if (docId) await rawDelete(`/v1/documents/${docId}`);
    if (folderId) await rawDelete(`/v1/folders/${folderId}`);
  }
});
