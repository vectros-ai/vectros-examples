import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

const BASE = (process.env.VECTROS_API_BASE_URL ?? 'https://api.vectros.ai').replace(/\/$/, '');
const KEY = process.env.VECTROS_API_KEY;

/**
 * document_ask aggregates the SSE stream into a non-empty answer.
 *
 * SELF-SEEDS the document (via document_ingest) rather than depending on a
 * seeded corpus — searching for a doc and silently `return`ing (a green PASS!)
 * when none is found can mask a stream-shape regression in the aggregation. A
 * real answer assertion against a known document is what actually verifies it.
 */
test('document_ask aggregates SSE stream into a non-empty answer', { timeout: 90_000 }, async (t) => {
  if (!KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  let docId: string | undefined;
  try {
    const ingest = await client.callTool({
      name: 'document_ingest',
      arguments: {
        title: 'MCP smoke — document_ask',
        text:
          'Vectros is a developer platform offering hybrid search, structured records, identity ' +
          'primitives, and in-perimeter inference. This document exists to smoke-test document_ask.',
      },
    });
    if (ingest.isError) {
      t.skip(`cannot ingest a document (key scope?): ${JSON.stringify(ingest)}`);
      return;
    }
    docId = parse(ingest).id as string;
    assert.ok(docId, 'ingest returned a document id');

    // document_ask requires the doc to be INDEXED (a fresh ingest is
    // PENDING_INDEX → 409). Poll document_get until it lands (bounded).
    let indexed = false;
    for (let i = 0; i < 30 && !indexed; i++) {
      const g = await client.callTool({ name: 'document_get', arguments: { documentId: docId } });
      if (!g.isError) {
        const status = parse(g).status;
        if (status === 'INDEXED') indexed = true;
      }
      if (!indexed) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!indexed) {
      t.skip('document did not reach INDEXED within the budget (indexing lag)');
      return;
    }

    const result = await client.callTool({
      name: 'document_ask',
      arguments: {
        documentId: docId,
        prompt: 'What platform is this document about? Answer in under 30 words.',
        model: 'claude-haiku-4-5',
        maxTokens: 200,
      },
    });
    assert.ok(!result.isError, `document_ask must not error: ${JSON.stringify(result)}`);
    const parsed = parse(result);
    assert.equal(typeof parsed.answer, 'string');
    assert.ok(parsed.answer.length > 0, `aggregated answer must be non-empty (got: ${JSON.stringify(parsed.answer)})`);
    assert.ok(parsed.usage, 'usage (token/billing) present');
  } finally {
    await close();
    // Best-effort teardown of the seeded document.
    if (docId) {
      await fetch(`${BASE}/v1/documents/${docId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${KEY}` },
      }).catch(() => {});
    }
  }
});
