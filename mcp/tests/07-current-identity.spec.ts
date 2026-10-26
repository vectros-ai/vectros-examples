import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

/**
 * current_identity smoke — exercises the live /v1/ping endpoint.
 *
 * The assertions accept BOTH the minimal shape
 * ({status, environment, principalType} only) AND the extended shape
 * (adds tenantId, principalKeyId, etc.). The extended fields are asserted
 * whenever the server returns them.
 */
test('current_identity returns at least the minimal shape', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'current_identity',
      arguments: {},
    });
    assert.ok(!result.isError, `current_identity must not error: ${JSON.stringify(result)}`);
    const body = parse(result) as Record<string, unknown>;
    // Minimum contract — always present.
    assert.equal(body.status, 'ok');
    // Environment is derived from the API URL: one of these two values.
    assert.ok(
      body.environment === 'staging' || body.environment === 'production',
      `environment derived: ${JSON.stringify(body.environment)}`,
    );
    // Principal type derivable from credential prefix.
    assert.ok(
      ['root_key', 'scoped_key', 'token'].includes(body.principalType as string),
      `principalType derived: ${JSON.stringify(body.principalType)}`,
    );
  } finally {
    await close();
  }
});

test('current_identity surfaces the extended fields when the server returns them', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'current_identity',
      arguments: {},
    });
    assert.ok(!result.isError);
    const body = parse(result) as Record<string, unknown>;
    // tenantId marks the extended shape; without it there are no extra
    // fields to assert.
    if (body.tenantId !== undefined) {
      assert.equal(typeof body.tenantId, 'string', 'tenantId is a string');
      assert.ok(body.principalKeyId, 'principalKeyId present in extended shape');
      // principalLabel + allowedActions + dataScope + tokenExpiresAt
      // are per-principal-type optional; no hard assert.
    } else {
      console.log('NOTE: /v1/ping returned the minimal shape; extended fields not asserted');
    }
  } finally {
    await close();
  }
});

/**
 * mcpServerVersion / sdkVersion — always derived by the MCP server itself, so
 * unlike the extended-ping fields above these are unconditional: present on
 * every call. The spec asserts only that they are real version strings, not
 * the exact values.
 */
test('current_identity reports mcpServerVersion + sdkVersion on the running build', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'current_identity',
      arguments: {},
    });
    assert.ok(!result.isError);
    const body = parse(result) as Record<string, unknown>;

    assert.equal(typeof body.mcpServerVersion, 'string', 'mcpServerVersion present');
    assert.equal(typeof body.sdkVersion, 'string', 'sdkVersion present');
    assert.notEqual(body.mcpServerVersion, 'dev', 'must be a real version string');
    assert.notEqual(body.sdkVersion, 'dev', 'must be a real version string');
  } finally {
    await close();
  }
});
