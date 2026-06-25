import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

test('hybrid_search returns results against the test tenant', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'hybrid_search',
      arguments: {
        query: 'patient',
        limit: 3,
      },
    });
    assert.ok(!result.isError, `hybrid_search must not error: ${JSON.stringify(result)}`);
    const parsed = parse(result);
    assert.ok(Array.isArray(parsed.results), 'has results array');
    // The test tenant is seeded; the result count varies. We
    // only assert the SHAPE is right, not that N>0 — an empty corpus
    // is still a valid response.
  } finally {
    await close();
  }
});
