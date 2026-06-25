import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

/**
 * current_identity smoke — exercises the live /v1/ping endpoint.
 *
 * Until the backend ships the extended ping response, the
 * assertions accept BOTH the degraded shape
 * ({status, environment, principalType} only) AND the extended shape
 * (adds tenantId, principalKeyId, etc.). When backend rolls out, this
 * spec automatically starts asserting the richer fields without an
 * MCP server release.
 */
test('current_identity returns at least the minimal degraded shape', async () => {
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
    // Environment derivable from URL — at least one of these.
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

test('current_identity surfaces extended fields when backend ships them', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'current_identity',
      arguments: {},
    });
    assert.ok(!result.isError);
    const body = parse(result) as Record<string, unknown>;
    // If tenantId is present, treat this as the extended-shape case.
    // Until then, this is a no-op assertion — soft signal that backend
    // hasn't shipped yet.
    if (body.tenantId !== undefined) {
      assert.equal(typeof body.tenantId, 'string', 'tenantId is a string');
      assert.ok(body.principalKeyId, 'principalKeyId present in extended shape');
      // principalLabel + allowedActions + dataScope + tokenExpiresAt
      // are per-principal-type optional; no hard assert.
    } else {
      console.log('NOTE: /v1/ping still returning degraded shape — backend extension not yet shipped');
    }
  } finally {
    await close();
  }
});
