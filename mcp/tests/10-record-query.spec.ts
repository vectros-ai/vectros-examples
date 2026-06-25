import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse, SMOKE_TYPE, SMOKE_EQUALITY_FIELD } from './fixtures.js';

/**
 * record_query smoke — both modes (list + lookup) go through the same page
 * envelope unwrap (`pageItems` → `.data`), so this verifies the agent-facing
 * output is a BARE records array, not the `{data,nextCursor}` page envelope.
 *
 * Runs against the shared `mcp_smoke_record` fixture provisioned by the 00-setup
 * spec (which also seeds a record). No catalog discovery, no "nothing to query"
 * skips — the fixture is guaranteed to exist with a known lookup field.
 */

test('record_query list mode returns a bare records array', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const parsed = parse(await client.callTool({ name: 'record_query', arguments: { type: SMOKE_TYPE, limit: 3 } }));
    // Unwrapped to a bare records array (NOT the {data,nextCursor} envelope).
    assert.ok(Array.isArray(parsed), 'record_query (list) returns a bare records array');
    assert.ok(parsed.length <= 3, 'respects the MCP limit cap');
    // 00-setup seeds a record, so the list is non-empty and the shape is real.
    assert.ok(parsed.length > 0 && parsed[0].id, 'seeded record present, with an id');
  } finally {
    await close();
  }
});

test('record_query lookup mode returns a bare array (no match → empty, not error)', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    // A sentinel value unlikely to match → exercises the unwrap on an empty page,
    // and confirms a no-match lookup is a normal empty result, not an error.
    const parsed = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_EQUALITY_FIELD, value: '__vectros_smoke_no_such_value__' },
      }),
    );
    assert.ok(Array.isArray(parsed), 'record_query (lookup) returns a bare array');
    assert.equal(parsed.length, 0, 'sentinel value matches nothing → empty, not error');
  } finally {
    await close();
  }
});
