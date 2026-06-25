import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse, SMOKE_TYPE } from './fixtures.js';

/**
 * version_history smoke — the audit trail of a record. Create a record of the
 * shared `mcp_smoke_record` type (typed records carry audit history by default), update
 * it, then read version_history and assert it captured both changes (CREATE + UPDATE).
 *
 * Returns the `{ data, nextCursor }` envelope; `data` is the version entries.
 */

test('version_history captures CREATE + UPDATE for a record', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  const externalId = `smoke-vh-${Date.now()}`;
  const { client, close } = await spawnServer();
  let recordId: string | undefined;
  try {
    const created = parse(
      await client.callTool({
        name: 'record_create',
        arguments: { type: SMOKE_TYPE, fields: { title: 'VH', status: 'open', rank: 'm10' }, externalId },
      }),
    );
    recordId = created.id as string;
    assert.ok(recordId, 'create returned an id');

    parse(
      await client.callTool({
        name: 'record_update',
        arguments: { id: recordId, fields: { status: 'closed' } },
      }),
    );

    // Version rows are emitted asynchronously (post-change), so the UPDATE entry can lag
    // the write by a moment — the CREATE shows up first. Poll until both are visible
    // (bounded), the same eventual-consistency tolerance the document-INDEXED wait uses.
    let history: { data?: any[]; nextCursor?: unknown } = {};
    for (let i = 0; i < 20; i++) {
      history = parse(
        await client.callTool({ name: 'version_history', arguments: { resourceType: 'record', id: recordId } }),
      );
      if (Array.isArray(history.data) && history.data.length >= 2) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(Array.isArray(history.data), `version_history returns a {data, nextCursor} envelope: ${JSON.stringify(history)}`);
    assert.ok(
      history.data!.length >= 2,
      `history captured CREATE + UPDATE (got ${history.data!.length}): ${JSON.stringify(history.data)}`,
    );
    assert.ok('nextCursor' in history, 'envelope carries a nextCursor key');
  } finally {
    await close();
    if (recordId) await api('DELETE', `/v1/records/${recordId}`).catch(() => {});
  }
});
