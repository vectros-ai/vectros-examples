import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse, SMOKE_TYPE, SMOKE_EQUALITY_FIELD } from './fixtures.js';

/**
 * record_query smoke — both modes (list + lookup) surface the same
 * `{data,nextCursor}` page envelope (the cursor reaches the agent), so this
 * verifies the agent-facing output is that envelope with `data` holding the records.
 *
 * Runs against the shared `mcp_smoke_record` fixture provisioned by the 00-setup
 * spec (which also seeds a record). No catalog discovery, no "nothing to query"
 * skips — the fixture is guaranteed to exist with a known lookup field.
 */

test('record_query list mode returns the {data,nextCursor} envelope', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const parsed = parse(await client.callTool({ name: 'record_query', arguments: { type: SMOKE_TYPE, limit: 3 } }));
    // The {data,nextCursor} page envelope; `data` holds the records.
    assert.ok(Array.isArray(parsed.data), `record_query (list) returns a {data,nextCursor} envelope: ${JSON.stringify(parsed)}`);
    assert.ok('nextCursor' in parsed, 'envelope carries a nextCursor key');
    assert.ok(parsed.data.length <= 3, 'respects the MCP limit cap');
    // 00-setup seeds a record, so the list is non-empty and the shape is real.
    assert.ok(parsed.data.length > 0 && parsed.data[0].id, 'seeded record present, with an id');
  } finally {
    await close();
  }
});

test('record_query lookup mode returns the {data,nextCursor} envelope (no match → empty, not error)', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    // A sentinel value unlikely to match → exercises the envelope on an empty page,
    // and confirms a no-match lookup is a normal empty result, not an error.
    const parsed = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_EQUALITY_FIELD, value: '__vectros_smoke_no_such_value__' },
      }),
    );
    assert.ok(Array.isArray(parsed.data), `record_query (lookup) returns a {data,nextCursor} envelope: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.data.length, 0, 'sentinel value matches nothing → empty, not error');
  } finally {
    await close();
  }
});
