import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse, resolveSmokeDocumentId } from './fixtures.js';

/**
 * document_get smoke — exercise both metadata-only and includeText paths.
 *
 * Two complementary strategies, both against the deterministic document fixture
 * the 00-setup spec seeds (idempotent by externalId, waited to INDEXED):
 *   (i)  DIRECT get-by-id — resolve the seeded document's id and document_get it.
 *        Independent of indexing; asserts the full metadata + stored-text contract.
 *   (ii) SEARCH → get — discover a document via hybrid_search (constrained to
 *        `contentTypes: ['documents']`, since unified search also returns RECORD
 *        hits whose id document_get would 404 on) and get it. The seeded INDEXED
 *        document guarantees a hit, so this no longer skips on an "empty corpus".
 */

async function findAnyDocumentId(client: Awaited<ReturnType<typeof spawnServer>>['client']): Promise<string | null> {
  const r = await client.callTool({
    name: 'hybrid_search',
    arguments: { query: 'platform', limit: 1, contentTypes: ['documents'] },
  });
  if (r.isError) return null;
  const body = parse(r) as { results?: Array<{ documentId?: string }> };
  return body.results?.[0]?.documentId ?? null;
}

test('(i) document_get returns metadata, and stored text with includeText, for the seeded document', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const id = await resolveSmokeDocumentId();
  assert.ok(id, 'the 00-setup spec seeded a document fixture');
  const { client, close } = await spawnServer();
  try {
    // Metadata only — no text body unless asked.
    const meta = parse(await client.callTool({ name: 'document_get', arguments: { documentId: id } }));
    assert.equal(meta.id, id, 'metadata id matches request');
    assert.equal(meta.text, undefined, 'no text when includeText:false');

    // includeText — the fixture was ingested storeText:true, so text is present.
    const withText = parse(
      await client.callTool({ name: 'document_get', arguments: { documentId: id, includeText: true } }),
    );
    assert.equal(withText.textAvailable, true, 'fixture stored its text → textAvailable:true');
    assert.equal(typeof withText.text, 'string', 'text body returned');
  } finally {
    await close();
  }
});

test('(ii) document_get resolves a document discovered via search', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const id = await findAnyDocumentId(client);
    // The seeded INDEXED document guarantees a document hit — no "empty corpus" skip.
    assert.ok(id, 'document-scoped hybrid_search returns a document (the seeded fixture is indexed)');
    const result = await client.callTool({ name: 'document_get', arguments: { documentId: id } });
    assert.ok(!result.isError, `document_get must not error: ${JSON.stringify(result)}`);
    const body = parse(result);
    assert.equal(body.id, id, 'metadata id matches the search hit');
    assert.equal(body.text, undefined, 'no text when includeText:false');
  } finally {
    await close();
  }
});

test('document_get returns isError on non-existent document', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'document_get',
      arguments: { documentId: 'doc_does_not_exist_pls_404' },
    });
    assert.equal(result.isError, true, 'unknown doc should surface as tool error (404)');
  } finally {
    await close();
  }
});
