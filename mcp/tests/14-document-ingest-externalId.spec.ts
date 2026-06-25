import { test } from 'node:test';
import assert from 'node:assert/strict';
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
