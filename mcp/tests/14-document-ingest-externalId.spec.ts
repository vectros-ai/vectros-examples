import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse } from './fixtures.js';

/**
 * document_ingest `externalId` parity smoke — without `externalId`, re-ingesting a
 * document would duplicate every time (while the sibling record_create is idempotent).
 *
 * This exercises:
 *   1. IDEMPOTENT INGEST — ingesting twice with the same `externalId` returns the
 *      SAME document id (not a duplicate), matching the record_create semantics.
 *   2. TYPED PAYLOAD — a `payload` passed at ingest round-trips on document_get
 *      (the old, silently-dropped `metadata` field is gone).
 *   3. UNTYPED CONFIRMATION — the platform refuses an `externalId` that arrives without a
 *      `schemaId` unless the call says an untyped document is intended. The documents here
 *      are genuinely untyped, so they pass `confirmUntyped: true`; the last cell proves the
 *      refusal is what the agent sees when it does not (the tool never confirms for it).
 */

const UNIQUE = `mcp-smoke-extid-${Date.now()}-${process.pid}`;

test('document_ingest is idempotent by externalId (re-ingest returns the same document)', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const externalId = `${UNIQUE}-idem`;
  const { client, close } = await spawnServer();
  let docId: string | undefined;
  try {
    const first = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `ExternalId smoke ${UNIQUE}`,
          text: 'First ingest. The same externalId must not create a duplicate on retry.',
          externalId,
          confirmUntyped: true,
          payload: { uid: UNIQUE, source: 'mcp-smoke' },
        },
      }),
    );
    assert.ok(first.id, `first ingest returned an id: ${JSON.stringify(first)}`);
    docId = first.id as string;

    // Re-ingest with the SAME externalId — must return the existing document, not a new one.
    const second = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `ExternalId smoke ${UNIQUE} (retry)`,
          text: 'Second ingest with the same externalId — should be idempotent.',
          externalId,
          confirmUntyped: true,
          payload: { uid: UNIQUE, source: 'mcp-smoke' },
        },
      }),
    );
    assert.equal(second.id, docId, 're-ingest with the same externalId returns the SAME id (no duplicate)');
  } finally {
    await close();
    if (docId) await api('DELETE', `/v1/documents/${docId}`).catch(() => {});
  }
});

test('document_ingest payload round-trips on document_get (the dead `metadata` field is gone)', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const externalId = `${UNIQUE}-payload`;
  const { client, close } = await spawnServer();
  let docId: string | undefined;
  try {
    const ingested = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `Payload smoke ${UNIQUE}`,
          text: 'A document whose structured payload must round-trip.',
          externalId,
          confirmUntyped: true,
          payload: { uid: UNIQUE, category: 'smoke' },
        },
      }),
    );
    docId = ingested.id as string;
    assert.ok(docId, 'ingest returned an id');

    const got = parse(await client.callTool({ name: 'document_get', arguments: { documentId: docId } }));
    assert.equal(got.payload?.uid, UNIQUE, 'payload.uid round-trips (was silently dropped as `metadata` before)');
    assert.equal(got.payload?.category, 'smoke', 'payload.category round-trips');
  } finally {
    await close();
    if (docId) await api('DELETE', `/v1/documents/${docId}`).catch(() => {});
  }
});

/** The id of a document a tool result reports creating, or undefined when the result is an error or has none. */
function createdId(result: {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  isError?: boolean;
  // `client.callTool()` returns a compatibility union; the index signature is what lets it through (see
  // `parseToolResult` in fixtures.ts).
  [k: string]: unknown;
}): string | undefined {
  if (result.isError) return undefined;
  try {
    const id = (parse(result) as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

test('document_ingest surfaces the platform refusal for an externalId without schemaId or confirmUntyped', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const externalId = `${UNIQUE}-refused`;
  const { client, close } = await spawnServer();
  // Every document this cell could end up creating, so a platform that stopped refusing cannot leave one behind.
  const createdIds: string[] = [];
  try {
    const refused = await client.callTool({
      name: 'document_ingest',
      arguments: {
        title: `Refused smoke ${UNIQUE}`,
        text: 'No schemaId and no confirmUntyped: the platform must refuse this.',
        externalId,
      },
    });
    const leaked = createdId(refused);
    if (leaked) createdIds.push(leaked);
    assert.equal(refused.isError, true, `an untyped externalId create must be refused: ${JSON.stringify(refused)}`);
    const text = JSON.stringify(refused.content ?? '');
    assert.match(text, /confirmUntyped/, `the refusal tells the caller what to pass: ${text}`);

    // Nothing was created under that externalId, so the same call with the confirmation is a fresh create.
    const created = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `Confirmed smoke ${UNIQUE}`,
          text: 'Same externalId, now with confirmUntyped.',
          externalId,
          confirmUntyped: true,
        },
      }),
    );
    assert.ok(created.id, `the confirmed create returned an id: ${JSON.stringify(created)}`);
    createdIds.push(created.id as string);
    assert.equal(created.created, true, 'the refused call left nothing behind, so this one creates');
  } finally {
    await close();
    for (const id of createdIds) await api('DELETE', `/v1/documents/${id}`).catch(() => {});
  }
});

test('document_ingest file mode surfaces the same refusal, and confirmUntyped clears it', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const externalId = `${UNIQUE}-file-refused`;
  const file = join(tmpdir(), `${UNIQUE}-file.txt`);
  await writeFile(file, `File-mode refusal smoke ${UNIQUE}.`);
  const { client, close } = await spawnServer({ VECTROS_MCP_INGEST_ROOT: tmpdir() });
  const createdIds: string[] = [];
  try {
    const refused = await client.callTool({
      name: 'document_ingest',
      arguments: { title: `File refused smoke ${UNIQUE}`, filePath: file, externalId, indexMode: 'HYBRID' },
    });
    const leaked = createdId(refused);
    if (leaked) createdIds.push(leaked);
    assert.equal(refused.isError, true, `an untyped externalId upload must be refused: ${JSON.stringify(refused)}`);
    assert.match(JSON.stringify(refused.content ?? ''), /confirmUntyped/, 'the refusal names the flag to pass');

    const created = parse(
      await client.callTool({
        name: 'document_ingest',
        arguments: {
          title: `File confirmed smoke ${UNIQUE}`,
          filePath: file,
          externalId,
          confirmUntyped: true,
          indexMode: 'HYBRID',
        },
      }),
    );
    assert.ok(created.id, `the confirmed upload returned an id: ${JSON.stringify(created)}`);
    createdIds.push(created.id as string);
    assert.equal(created.created, true, 'the refused upload left nothing behind, so this one creates');
  } finally {
    await close();
    await unlink(file).catch(() => {});
    for (const id of createdIds) await api('DELETE', `/v1/documents/${id}`).catch(() => {});
  }
});
