import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse, SMOKE_TYPE, SMOKE_EQUALITY_FIELD, SMOKE_RANGE_FIELD } from './fixtures.js';

/**
 * Records-I/O tier smoke — the full write lifecycle:
 * create → get → query (list + equality/prefix/range lookup) → update
 * (merge + optimistic-concurrency conflict) → delete.
 *
 * The shared `mcp_smoke_record` schema is provisioned by the 00-setup spec
 * (`status` = equality lookup, `rank` = range lookup). This spec creates and
 * tears down its OWN record: equality lookups hit `status`, prefix/range hit
 * `rank`, and each asserts the record is actually returned (not just that the
 * call shape is the {data,nextCursor} envelope).
 */

test('record_query / get / create / update / delete lifecycle', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  const externalId = `smoke-${Date.now()}`;
  const { client, close } = await spawnServer();
  let recordId: string | undefined;
  try {
    // CREATE — the server resolves the schema from typeName; idempotent by externalId.
    // `rank` carries a sortable value so the prefix/range lookups below find this record.
    const created = parse(
      await client.callTool({
        name: 'record_create',
        arguments: {
          type: SMOKE_TYPE,
          fields: { title: 'Smoke', status: 'todo', rank: 'm50', note: 'keep' },
          externalId,
        },
      }),
    );
    assert.ok(created.id, `create returned an id: ${JSON.stringify(created)}`);
    recordId = created.id as string;
    assert.equal(created.payload?.status, 'todo');

    // GET — full payload.
    const got = parse(await client.callTool({ name: 'record_get', arguments: { id: recordId } }));
    assert.equal(got.id, recordId);
    assert.equal(got.payload?.title, 'Smoke');

    // QUERY list — {data,nextCursor} envelope with our record in `data`.
    const listed = parse(await client.callTool({ name: 'record_query', arguments: { type: SMOKE_TYPE } }));
    assert.ok(Array.isArray(listed.data), `list mode returns a {data,nextCursor} envelope: ${JSON.stringify(listed)}`);

    // QUERY lookup — EQUALITY / PREFIX / RANGE. These assert the record is FOUND
    // without polling: lookup rows (GSI slots + range rows) are written synchronously
    // with the record write, unlike async search/embedding indexing. If a future
    // backend change ever makes lookup-row propagation eventually-consistent, these
    // three asserts are the first place that would flake.
    // EQUALITY on `status` (the GSI-slot lookup field).
    const eq = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_EQUALITY_FIELD, value: 'todo', limit: 10 },
      }),
    );
    assert.ok(Array.isArray(eq.data) && eq.data.some((r: any) => r.id === recordId), 'equality lookup finds the record');

    // QUERY lookup — PREFIX on `rank` (the range field); 'm50' starts with 'm'.
    const pre = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_RANGE_FIELD, prefix: 'm', limit: 10 },
      }),
    );
    assert.ok(Array.isArray(pre.data) && pre.data.some((r: any) => r.id === recordId), 'prefix lookup finds the record');

    // QUERY lookup — RANGE on `rank`; 'm50' falls within [a, z].
    const rng = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_RANGE_FIELD, from: 'a', to: 'z', limit: 10 },
      }),
    );
    assert.ok(Array.isArray(rng.data) && rng.data.some((r: any) => r.id === recordId), 'range lookup finds the record');

    // UPDATE — RFC-7386 merge-patch (title/note deep-merge-preserved, status changed);
    // expectedVersion is forwarded and the server enforces optimistic concurrency.
    const updated = parse(
      await client.callTool({
        name: 'record_update',
        arguments: { id: recordId, fields: { status: 'done' }, expectedVersion: got.version },
      }),
    );
    assert.equal(updated.payload?.status, 'done', 'status merged to done');
    assert.equal(updated.payload?.title, 'Smoke', 'title preserved by the merge');
    assert.equal(updated.payload?.note, 'keep', 'note preserved by the merge');

    // UPDATE conflict — the now-stale expectedVersion is rejected server-side (409).
    const conflict = await client.callTool({
      name: 'record_update',
      arguments: { id: recordId, fields: { status: 'reopened' }, expectedVersion: got.version },
    });
    assert.equal(conflict.isError, true, 'stale expectedVersion → conflict');
    assert.match(String((conflict as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''), /409|conflict/i);

    // DELETE — then a get must fail.
    const del = parse(await client.callTool({ name: 'record_delete', arguments: { id: recordId } }));
    assert.equal(del.deleted, true);
    const afterDelete = await client.callTool({ name: 'record_get', arguments: { id: recordId } });
    assert.equal(afterDelete.isError, true, 'record_get after delete returns an error');
    recordId = undefined; // deleted; no teardown needed
  } finally {
    await close();
    // Best-effort teardown of the record if a step failed before delete.
    if (recordId) await api('DELETE', `/v1/records/${recordId}`).catch(() => {});
  }
});
