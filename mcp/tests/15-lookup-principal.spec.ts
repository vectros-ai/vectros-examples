import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse } from './fixtures.js';

/**
 * lookup_principal smoke — resolve an identity by your own externalId to its
 * Vectros UUID (the id the ownership filters on record_query / hybrid_search / rag_ask
 * expect). A CLIENT is the cheapest identity to seed (externalId is its only required
 * field). Seeding is via the raw API (identity CRUD is intentionally NOT an MCP tool);
 * the RESOLVE is the MCP tool under test.
 *
 * If the smoke key can't create clients (403), the resolve test skips — a real
 * precondition, never a false pass.
 */

const EXTERNAL_ID = `mcp-smoke-client-${Date.now()}-${process.pid}`;

test('lookup_principal resolves a client by externalId to its Vectros id', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  // Seed a client (idempotent by externalId) via the raw API.
  const seed = await api('POST', '/v1/clients', { externalId: EXTERNAL_ID, name: 'MCP smoke client' });
  if (seed.status === 403) {
    t.skip('smoke key cannot create clients (non-root) — resolve test skipped');
    return;
  }
  assert.ok(seed.status >= 200 && seed.status < 300, `seed client failed: HTTP ${seed.status} ${JSON.stringify(seed.json)}`);
  const seededId = seed.json?.id as string;
  assert.ok(seededId, 'seeded client has a Vectros id');

  const { client, close } = await spawnServer();
  try {
    const resolved = parse(
      await client.callTool({
        name: 'lookup_principal',
        arguments: { kind: 'client', externalId: EXTERNAL_ID },
      }),
    );
    assert.ok(Array.isArray(resolved), 'resolve returns a bare array');
    assert.ok(
      resolved.some((c: any) => c.id === seededId),
      `resolve finds the seeded client by externalId (expected id ${seededId}): ${JSON.stringify(resolved)}`,
    );
  } finally {
    await close();
    if (seededId) await api('DELETE', `/v1/clients/${seededId}`).catch(() => {});
  }
});

test('lookup_principal with neither externalId nor a field lookup returns isError', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({ name: 'lookup_principal', arguments: { kind: 'user' } });
    assert.equal(result.isError, true, 'must reject when no lookup mode is given');
  } finally {
    await close();
  }
});
