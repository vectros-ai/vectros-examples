import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse, SMOKE_TYPE, SMOKE_RANGE_FIELD } from './fixtures.js';

/**
 * Query-surface parity smoke — the field additions on the existing read tools:
 *   • list_schemas `recordType` filter resolves the one schema by its type name.
 *   • record_query lookup `order` (asc/desc) controls result direction.
 *   • hybrid_search keyword-precision (`textMode`) + `requireComplete` are accepted.
 *
 * The ordering check isolates its own two records with a UNIQUE rank prefix, so it is
 * deterministic regardless of other records of the smoke type in the tenant.
 */

test('list_schemas resolves a single schema by recordType', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const schemas = parse(await client.callTool({ name: 'list_schemas', arguments: { recordType: SMOKE_TYPE } }));
    assert.ok(Array.isArray(schemas), 'list_schemas returns a bare array');
    assert.ok(
      schemas.some((s: any) => s.typeName === SMOKE_TYPE),
      `recordType filter resolves the ${SMOKE_TYPE} schema: ${JSON.stringify(schemas.map((s: any) => s.typeName))}`,
    );
  } finally {
    await close();
  }
});

test('record_query lookup honors order=desc vs asc', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const uid = `${Date.now()}${process.pid}`;
  const prefix = `s17${uid}`; // unique → the prefix lookup returns ONLY this test's records
  const rankA = `${prefix}a`;
  const rankB = `${prefix}b`; // rankB > rankA lexicographically
  const { client, close } = await spawnServer();
  const ids: string[] = [];
  try {
    for (const [tag, rank] of [['A', rankA], ['B', rankB]] as const) {
      const r = parse(
        await client.callTool({
          name: 'record_create',
          arguments: { type: SMOKE_TYPE, fields: { title: `order-${tag}`, status: 'open', rank }, externalId: `${prefix}-${tag}` },
        }),
      );
      ids.push(r.id as string);
    }

    const desc = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_RANGE_FIELD, prefix, order: 'desc', limit: 10 },
      }),
    );
    assert.ok(Array.isArray(desc.data) && desc.data.length >= 2, `prefix lookup returned both records: ${JSON.stringify(desc)}`);
    assert.equal(desc.data[0].payload?.rank, rankB, 'desc → higher rank first');
    assert.equal(desc.data[1].payload?.rank, rankA, 'desc → lower rank second');

    const asc = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_RANGE_FIELD, prefix, order: 'asc', limit: 10 },
      }),
    );
    assert.equal(asc.data[0].payload?.rank, rankA, 'asc → lower rank first (opposite of desc)');
  } finally {
    await close();
    for (const id of ids) await api('DELETE', `/v1/records/${id}`).catch(() => {});
  }
});

test('hybrid_search accepts textMode + requireComplete', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  try {
    const result = await client.callTool({
      name: 'hybrid_search',
      arguments: { query: 'vectros developer platform', textMode: 'AND', requireComplete: false, limit: 5 },
    });
    assert.ok(!result.isError, `hybrid_search with precision knobs must not error: ${JSON.stringify(result)}`);
    const body = parse(result);
    assert.ok(Array.isArray(body.results), 'returns a results array');
  } finally {
    await close();
  }
});
