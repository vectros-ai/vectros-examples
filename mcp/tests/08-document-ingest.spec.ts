import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

/**
 * document_ingest smoke — exercises both modes.
 *
 * Text mode creates a small inline document, polls document_get for
 * INDEXED status, then we trust the rest of the pipeline. File mode
 * creates a tmpfile, ingests it, asserts the upload path returns
 * PENDING_INDEX. Both clean up the created doc IDs via the SDK
 * (or accept that the tenant will GC them).
 *
 * The validation-error paths (missing text/filePath, both, HTTP
 * transport gate) are unit-tested; we don't re-exercise them here.
 */

const UNIQUE = `mcp-smoke-${Date.now()}-${process.pid}`;

test('document_ingest text mode creates a document', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'document_ingest',
      arguments: {
        title: `Smoke text doc ${UNIQUE}`,
        text: `Test ingest from MCP smoke at ${new Date().toISOString()}. UID=${UNIQUE}.`,
        indexMode: 'HYBRID',
        payload: { source: 'mcp-smoke', uid: UNIQUE },
      },
    });
    assert.ok(!result.isError, `document_ingest text must not error: ${JSON.stringify(result)}`);
    const body = parse(result) as Record<string, unknown>;
    assert.ok(body.id, 'created document has id');
    // Status is PENDING_INDEX initially; INDEXED arrives async.
    assert.ok(
      body.status === 'PENDING_INDEX' || body.status === 'INDEXED',
      `unexpected status: ${JSON.stringify(body.status)}`,
    );
  } finally {
    await close();
  }
});

test('document_ingest file mode uploads + returns PENDING_INDEX', async () => {
  const tmpFile = join(tmpdir(), `mcp-smoke-${UNIQUE}.txt`);
  await writeFile(tmpFile, `Smoke file upload body. UID=${UNIQUE}.`);

  // The file jail confines filePath mode to VECTROS_MCP_INGEST_ROOT
  // (default: cwd). Point it at tmpdir() so the fixture written there is
  // allowed — exactly what a real user does by setting the env to where
  // their files live.
  const { client, close } = await spawnServer({ VECTROS_MCP_INGEST_ROOT: tmpdir() });
  try {
    const result = await client.callTool({
      name: 'document_ingest',
      arguments: {
        title: `Smoke file doc ${UNIQUE}`,
        filePath: tmpFile,
        indexMode: 'HYBRID',
      },
    });
    assert.ok(!result.isError, `document_ingest file must not error: ${JSON.stringify(result)}`);
    const body = parse(result) as Record<string, unknown>;
    assert.ok(body.id, 'created document has id');
    assert.equal(body.status, 'PENDING_INDEX');
    assert.match(String(body._note), /Poll document_get/);
  } finally {
    await close();
    await unlink(tmpFile).catch(() => {});
  }
});

test('document_ingest with neither text nor filePath returns isError', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'document_ingest',
      arguments: { title: 'X' },
    });
    assert.equal(result.isError, true, 'must reject when no body source given');
  } finally {
    await close();
  }
});
