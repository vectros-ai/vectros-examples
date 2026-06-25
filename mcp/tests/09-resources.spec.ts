import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';

/**
 * Resources smoke — verify schemas + identity resources read and
 * return well-formed JSON. The data assertions mirror
 * the tool smoke specs (list_schemas, current_identity) since the
 * resources are intentionally parallel to those tools.
 */
test('schemas resource reads JSON catalog', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.readResource({ uri: 'vectros://schemas' });
    assert.ok(result.contents && result.contents.length > 0, 'has contents');
    const first = result.contents[0];
    assert.equal(first.uri, 'vectros://schemas');
    assert.equal(first.mimeType, 'application/json');
    const parsed = JSON.parse((first as { text?: string }).text ?? '');
    assert.ok(Array.isArray(parsed), 'schemas resource returns a bare array');
    // Don't assert non-empty — the tenant might be reseeded.
  } finally {
    await close();
  }
});

test('identity resource reads at least the minimal degraded shape', async () => {
  const { client, close } = await spawnServer();
  try {
    const result = await client.readResource({ uri: 'vectros://identity' });
    const first = result.contents?.[0];
    assert.equal(first?.uri, 'vectros://identity');
    assert.equal(first?.mimeType, 'application/json');
    const parsed = JSON.parse((first as { text?: string } | undefined)?.text ?? '') as Record<string, unknown>;
    // Same minimum contract as current_identity tool smoke.
    assert.equal(parsed.status, 'ok');
    assert.ok(
      parsed.environment === 'staging' || parsed.environment === 'production',
      `environment derived: ${JSON.stringify(parsed.environment)}`,
    );
    assert.ok(
      ['root_key', 'scoped_key', 'token'].includes(parsed.principalType as string),
      `principalType derived: ${JSON.stringify(parsed.principalType)}`,
    );
  } finally {
    await close();
  }
});

test('unknown resource URI returns a protocol error', async () => {
  const { client, close } = await spawnServer();
  try {
    await assert.rejects(
      () => client.readResource({ uri: 'vectros://does-not-exist' }),
      /No such resource URI|MCP error/i,
    );
  } finally {
    await close();
  }
});
