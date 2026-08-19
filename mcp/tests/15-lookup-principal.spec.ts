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

  // Seed a client entity (idempotent by externalId) via the raw API.
  const seed = await api('POST', '/v1/entities/client', { externalId: EXTERNAL_ID, name: 'MCP smoke client' });
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
    assert.ok(Array.isArray(resolved.data), `resolve returns a {data,nextCursor} envelope: ${JSON.stringify(resolved)}`);
    assert.ok(
      resolved.data.some((c: any) => c.id === seededId),
      `resolve finds the seeded client by externalId (expected id ${seededId}): ${JSON.stringify(resolved)}`,
    );
  } finally {
    await close();
    if (seededId) await api('DELETE', `/v1/entities/client/${seededId}`).catch(() => {});
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

test('lookup_principal (lookup mode) forwards contextId as its own query param to lookupEntities, which rejects it for a tenant-wide namespace', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  // `contextId` is a QUERY parameter on the lookupEntities POST, a SIBLING of the criteria body —
  // never part of it: it names the partition, not the lookup criteria, so it does not belong inside
  // the body. `lookup_principal.ts` already gets this right
  // (`lookupEntities({ namespace, contextId, body: req })` — contextId is a sibling of `body`, not
  // folded into it); this test exists to prove that sibling placement actually reaches the live API.
  //
  // Requires the `client` namespace to already be registered (00-setup-fixtures) — an unregistered
  // namespace answers 200/empty instead of rejecting, which would fail this assertion for the WRONG
  // reason. Check first and skip honestly rather than let that surface as a misleading assertion
  // failure.
  const registered = await api('GET', '/v1/namespaces/client');
  if (registered.status !== 200) {
    t.skip(`'client' namespace not registered (00-setup-fixtures skipped or failed) — HTTP ${registered.status}`);
    return;
  }
  // `type` doesn't need to name a real schema for this assertion — the backend's namespace-placement
  // check runs before any schema lookup, so it fires regardless.
  //
  // Previously this test could only assert "doesn't error" — a direct probe found contextId
  // silently accepted (200, empty result) even against a tenant-wide namespace, which didn't match
  // this package's own documented contract. Root cause was a backend defect (a stale contextId read
  // from a prior request on a reused server instance, now fixed) — re-probed directly against
  // staging before tightening this assertion.
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'lookup_principal',
      arguments: { kind: 'client', type: 'mcp-smoke-contextid-probe', field: 'name', value: 'x', contextId: 'default' },
    });
    assert.equal(result.isError, true, `contextId against a tenant-wide namespace must be rejected: ${JSON.stringify(result)}`);
    const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
    assert.match(text, /tenant-placed|remove 'contextId'/i, `expected the backend's tenant-wide rejection, got: ${text}`);
  } finally {
    await close();
  }
});
