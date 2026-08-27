import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';

test('MCP handshake + tools/list returns expected catalog', async () => {
  // This list grows as v0.2 tools land. Keep in lockstep with the
  // server's registered tool catalog.
  const expectedTools = [
    // v0.1
    'document_ask',
    'hybrid_search',
    'rag_ask',
    'record_query',
    // v0.2
    'list_schemas',
    'document_get',
    'current_identity',
    'document_ingest',
    // launch data-plane I/O (tier 1)
    'record_get',
    'record_create',
    'record_update',
    'record_delete',
    // 0.41.0: record_batch_get (wraps POST /v1/records/batch-get)
    'record_batch_get',
    // launch data-plane I/O (tier 2)
    'document_query',
    // launch data-plane I/O (tier 3)
    'document_update',
    'document_delete',
    'folder_query',
    'folder_create',
    'folder_update',
    'folder_delete',
    // tool-surface parity
    'lookup_principal',
    'version_history',
  ].sort();

  const { client, close } = await spawnServer();
  try {
    const tools = await client.listTools();
    const names = (tools.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, expectedTools);
    for (const t of tools.tools ?? []) {
      assert.ok(t.description && t.description.length > 20, `${t.name}: substantive description`);
      assert.ok(t.inputSchema, `${t.name}: inputSchema present`);
    }

    // resources/list returns the v0.2 resource catalog.
    const resources = await client.listResources();
    const resNames = (resources.resources ?? []).map((r) => r.name).sort();
    assert.deepEqual(resNames, ['identity', 'schemas']);
  } finally {
    await close();
  }
});
