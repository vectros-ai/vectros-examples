import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse, SMOKE_TYPE } from './fixtures.js';

/**
 * record_batch_write smoke — `POST /v1/records/batch`, live as of API 0.43.0
 * (previously a 501 stub).
 *
 * Three things worth proving against the real API rather than a mock, because
 * each is a place the tool's own contract could be right locally and wrong on
 * the wire:
 *
 *   1. best_effort writes several records in one call, and the per-item
 *      `index` really does line up with the order submitted (that mapping is
 *      the only way a caller matches a result to its item).
 *   2. all_or_nothing genuinely writes NOTHING when one item is bad — asserted
 *      by reading back the good item's externalId afterwards, not by trusting
 *      the reported status.
 *   3. The endpoint answers 200 for a batch in which every item failed, so the
 *      MCP call is NOT an error result. A regression that started reporting
 *      isError here would look like a safety improvement and would actually
 *      break every caller branching on the per-item results.
 *
 * Assertions are seeding-tolerant: this spec creates and tears down its own
 * records against the shared `mcp_smoke_record` schema from the 00-setup spec.
 */

test('record_batch_write — best_effort, all_or_nothing rollback, and all-failed shape', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  const stamp = Date.now();
  const extA = `smoke-batch-a-${stamp}`;
  const extB = `smoke-batch-b-${stamp}`;
  const extRollback = `smoke-batch-rollback-${stamp}`;
  const created: string[] = [];
  // Registered for teardown by externalId as well as id: if the rollback assertion FAILS,
  // the good item did commit, and the assertion throws before any id is captured — so
  // without this the run leaks exactly the row whose existence it was reporting.
  const createdExternalIds: string[] = [];
  const { client, close } = await spawnServer();

  try {
    // ---- 1. best_effort: two good items in one call ------------------------
    const batch = parse(
      await client.callTool({
        name: 'record_batch_write',
        arguments: {
          items: [
            { type: SMOKE_TYPE, fields: { title: 'Batch A', status: 'todo', rank: 'm10' }, externalId: extA },
            { type: SMOKE_TYPE, fields: { title: 'Batch B', status: 'todo', rank: 'm11' }, externalId: extB },
          ],
        },
      }),
    );
    assert.equal(batch.succeeded, 2, `both items written: ${JSON.stringify(batch)}`);
    assert.equal(batch.failed, 0);
    const results = batch.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 2);
    for (const r of results) created.push(r.id as string);

    // `index` is how a caller matches a result to the item it sent. The API does NOT
    // guarantee results arrive in submission order, so assert the SET of indexes and
    // then correlate through it — asserting the order would encode a guarantee the
    // endpoint explicitly declines to make, and would pass until it one day didn't.
    assert.deepEqual(
      results.map((r) => r.index as number).sort((x, y) => x - y),
      [0, 1],
      'every submitted position is accounted for exactly once',
    );
    const byIndex = new Map(results.map((r) => [r.index as number, r]));
    const readA = parse(await client.callTool({ name: 'record_get', arguments: { id: byIndex.get(0)!.id } }));
    assert.equal(readA.payload?.title, 'Batch A', 'index 0 correlates to the record submitted at position 0');
    const readB = parse(await client.callTool({ name: 'record_get', arguments: { id: byIndex.get(1)!.id } }));
    assert.equal(readB.payload?.title, 'Batch B', 'index 1 correlates to the record submitted at position 1');

    // POSITIVE CONTROL for the rollback proof below. That proof asserts a record_get by
    // externalId+type FAILS. `isError: true` is also what a missing schema, a lookup
    // transport error, or a credential without records:r would produce — i.e. the proof
    // would go green in exactly the case it exists to catch. Show the selector working
    // here, in the same run, on a record we know committed.
    const controlRead = await client.callTool({
      name: 'record_get',
      arguments: { externalId: extA, type: SMOKE_TYPE },
    });
    assert.notEqual(
      controlRead.isError,
      true,
      'externalId+type resolution must WORK here, or the rollback assertion below proves nothing',
    );
    assert.equal(parse(controlRead).payload?.title, 'Batch A');

    // ---- 2. all_or_nothing rolls the whole batch back ----------------------
    // One good item, one referencing a type that does not exist. Nothing may commit.
    createdExternalIds.push(extRollback);
    const abortedResult = await client.callTool({
      name: 'record_batch_write',
      arguments: {
        atomicity: 'all_or_nothing',
        items: [
          {
            type: SMOKE_TYPE,
            fields: { title: 'Rollback', status: 'todo', rank: 'm12' },
            externalId: extRollback,
          },
          { type: 'mcp_smoke_type_that_does_not_exist', fields: { title: 'bad' } },
        ],
      },
    });
    assert.notEqual(
      abortedResult.isError,
      true,
      'a rejected all_or_nothing batch is still a PROCESSED batch, not a call error',
    );
    const aborted = parse(abortedResult);
    assert.equal(aborted.succeeded, 0, `nothing succeeded: ${JSON.stringify(aborted)}`);

    // The real proof: the good item must not exist. Read it back through the
    // server's own externalId selector rather than trusting the reported status.
    const rollbackRead = await client.callTool({
      name: 'record_get',
      arguments: { externalId: extRollback, type: SMOKE_TYPE },
    });
    assert.equal(
      rollbackRead.isError,
      true,
      'all_or_nothing must write NOTHING when an item fails — the good item resolved, so it committed',
    );
    // Pin WHICH failure. The positive control above proves the selector works, and this
    // proves the error is "no such record" rather than some other fault that happens to
    // present as isError.
    assert.match(
      String((rollbackRead as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''),
      /no record|not found|404/i,
      'the rollback proof must fail with a not-found, not an unrelated error',
    );

    // ---- 3. a batch in which EVERY item fails is still not an error result --
    const allFailed = await client.callTool({
      name: 'record_batch_write',
      arguments: {
        items: [
          { type: 'mcp_smoke_type_that_does_not_exist', fields: { title: 'x' } },
          { type: 'mcp_smoke_type_that_does_not_exist', fields: { title: 'y' } },
        ],
      },
    });
    assert.notEqual(
      allFailed.isError,
      true,
      'the endpoint answers 200 whenever the batch was PROCESSED — the per-item results carry the failure',
    );
    const allFailedBody = parse(allFailed);
    assert.equal(allFailedBody.succeeded, 0);
    assert.equal(allFailedBody.failed, 2, `every item reported failed: ${JSON.stringify(allFailedBody)}`);
  } finally {
    await close();
    for (const id of created) {
      if (id) await api('DELETE', `/v1/records/${id}`).catch(() => {});
    }
    // Sweep anything registered by externalId that may have committed despite the
    // assertions (the rollback-failed case). Resolving it is best-effort by design.
    for (const ext of createdExternalIds) {
      const found = await api(
        'GET',
        `/v1/records/lookup?type=${encodeURIComponent(SMOKE_TYPE)}&field=externalId&value=${encodeURIComponent(ext)}`,
      ).catch(() => undefined);
      const rows = ((found?.json as { data?: Array<{ id?: string }> } | undefined)?.data ?? []);
      for (const row of rows) {
        if (row.id) await api('DELETE', `/v1/records/${row.id}`).catch(() => {});
      }
    }
  }
});
