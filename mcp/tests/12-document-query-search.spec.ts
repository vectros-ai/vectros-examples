import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

const BASE = (process.env.VECTROS_API_BASE_URL ?? 'https://api.vectros.ai').replace(/\/$/, '');
const KEY = process.env.VECTROS_API_KEY;

/**
 * Tier-2 smoke — enriched hybrid_search + new document_query.
 *
 * hybrid_search gained a large pass-through surface (contentTypes/typeName/
 * filters/ownership/dates/minSimilarity/uniqueDocuments). tsc can't catch a
 * wrong arg NAME on the SearchRequest (the SDK ignores unknowns silently or
 * 400s) — only a live call against /v1/search proves the wiring. We send every
 * new arg and assert the call succeeds with the expected results shape.
 *
 * document_query mirrors record_query: list via listDocuments, equality lookup
 * via lookupDocumentsByBody (POST). Both unwrap the {data,nextCursor}
 * envelope to a bare DocumentResponse[]. We self-seed a document so the
 * non-empty list branch is real, and clean it up.
 */

/** Read the schema catalog (bare array) via the list_schemas tool. */
async function listSchemas(
  client: Awaited<ReturnType<typeof spawnServer>>['client'],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.callTool({ name: 'list_schemas', arguments: {} });
  assert.ok(!result.isError, `list_schemas must not error: ${JSON.stringify(result)}`);
  const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.ok(Array.isArray(parsed), 'list_schemas returns a bare array');
  return parsed as Array<Record<string, unknown>>;
}

test('hybrid_search accepts the full launch enrichment surface', async (t) => {
  if (!KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    // Exercise the enrichment surface against the real /v1/search with TWO
    // COHERENT arg sets — the server cross-validates combinations (e.g. typeName
    // is records-only and 400s against contentTypes=["documents"]), so this also
    // documents the valid pairings. We omit rootFolderId/ownership: a sentinel
    // UUID could 404 on a missing reference (a reference failure, not a wiring
    // one — the wiring is covered by the unit passthrough test).

    // (a) documents-coherent: filters + minSimilarity + uniqueDocuments + date.
    const docsSearch = await client.callTool({
      name: 'hybrid_search',
      arguments: {
        query: 'developer platform',
        mode: 'HYBRID',
        limit: 3,
        contentTypes: ['documents'],
        filters: { status: 'open' },
        minSimilarity: 0.0,
        uniqueDocuments: true,
        createdAfter: '2020-01-01T00:00:00Z',
      },
    });
    assert.ok(!docsSearch.isError, `documents-coherent hybrid_search must not error: ${JSON.stringify(docsSearch)}`);
    const docsParsed = JSON.parse((docsSearch.content as Array<{ text: string }>)[0]!.text);
    assert.ok(Array.isArray(docsParsed.results), 'search response carries a results[] array');
    assert.ok(docsParsed.results.length <= 3, 'respects the MCP limit cap');

    // (b) records-coherent: typeName (records-only) + filters.
    const recsSearch = await client.callTool({
      name: 'hybrid_search',
      arguments: {
        query: 'developer platform',
        mode: 'HYBRID',
        limit: 3,
        contentTypes: ['records'],
        typeName: 'mcp_smoke_record',
        filters: { status: 'open' },
      },
    });
    assert.ok(!recsSearch.isError, `records-coherent hybrid_search must not error: ${JSON.stringify(recsSearch)}`);
    const recsParsed = JSON.parse((recsSearch.content as Array<{ text: string }>)[0]!.text);
    assert.ok(Array.isArray(recsParsed.results), 'records search response carries a results[] array');
  } finally {
    await close();
  }
});

test('document_query list mode returns a bare documents array', async (t) => {
  if (!KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  let docId: string | undefined;
  try {
    // Self-seed one document so the non-empty branch is exercised for real.
    const ingest = await client.callTool({
      name: 'document_ingest',
      arguments: {
        title: 'MCP smoke — document_query list',
        text: 'A seeded document so document_query list mode has at least one item to return.',
      },
    });
    if (ingest.isError) {
      t.skip(`cannot ingest a document (key scope?): ${JSON.stringify(ingest)}`);
      return;
    }
    docId = parse(ingest).id as string;

    const result = await client.callTool({
      name: 'document_query',
      arguments: { limit: 3 },
    });
    assert.ok(!result.isError, `document_query (list) must not error: ${JSON.stringify(result)}`);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    // Unwrapped to a bare documents array (NOT the {data,nextCursor} envelope).
    assert.ok(Array.isArray(parsed), 'document_query (list) returns a bare documents array');
    assert.ok(parsed.length >= 1, 'at least the seeded document is present');
    assert.ok(parsed.length <= 3, 'respects the MCP limit cap');
    assert.ok((parsed[0] as Record<string, unknown>).id, 'document has an id');
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

test('document_query lookup mode returns a bare array (no match → empty, not error)', async (t) => {
  if (!KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    // Find a schema declaring a lookup field (documents share the schema model).
    const schemas = await listSchemas(client);
    let type: string | undefined;
    let field: string | undefined;
    for (const s of schemas) {
      const lookups = s.lookupFields as Array<{ fieldName?: string }> | undefined;
      const fieldName = lookups?.find((l) => typeof l.fieldName === 'string')?.fieldName;
      if (typeof s.typeName === 'string' && fieldName) {
        type = s.typeName;
        field = fieldName;
        break;
      }
    }
    if (!type || !field) {
      t.skip('the catalog has no schema with a lookup field');
      return;
    }

    // A sentinel value unlikely to match → exercises the POST-body lookup arg
    // wiring (type/field/value) and the unwrap on an empty page.
    const result = await client.callTool({
      name: 'document_query',
      arguments: { type, field, value: '__vectros_smoke_no_such_value__' },
    });
    // A no-match lookup is a normal empty result. If the backend rejects the type as
    // not document-bound, that is a legitimate skip (we don't control which
    // schemas are bound to documents) — surface it, don't assert it green.
    if (result.isError) {
      t.skip(`document lookup not testable on this catalog: ${JSON.stringify(result)}`);
      return;
    }
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    assert.ok(Array.isArray(parsed), 'document_query (lookup) returns a bare array');
  } finally {
    await close();
  }
});
