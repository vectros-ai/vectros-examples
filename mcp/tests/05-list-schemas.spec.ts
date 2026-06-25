import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

test('list_schemas returns the tenant schema catalog', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'list_schemas',
      arguments: {},
    });
    assert.ok(!result.isError, `list_schemas must not error: ${JSON.stringify(result)}`);
    const parsed = parse(result);
    // Response is a bare array (not wrapped in {schemas: [...]}).
    assert.ok(Array.isArray(parsed), 'list_schemas returns a bare array');
    // The test tenant is seeded with at least one schema, but we only
    // assert SHAPE — an empty catalog would still be a valid response
    // if the tenant happens to be unseeded.
    if (parsed.length > 0) {
      const sample = parsed[0] as Record<string, unknown>;
      // Every schema has at minimum id + typeName.
      assert.ok(sample.id, 'schema has id');
      assert.ok(sample.typeName, 'schema has typeName');
    }
  } finally {
    await close();
  }
});

test('list_schemas with userId filter does not error', async () => {
  // Even with a userId that has no schemas, the response should be
  // a valid empty array — not an error. This exercises the filter
  // arg passthrough without depending on seeded data.
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'list_schemas',
      arguments: { userId: 'usr_does_not_exist' },
    });
    assert.ok(!result.isError, `list_schemas with filter must not error: ${JSON.stringify(result)}`);
    const parsed = parse(result);
    assert.ok(Array.isArray(parsed), 'response is still a bare array');
  } finally {
    await close();
  }
});
