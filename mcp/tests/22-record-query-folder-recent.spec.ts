import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { api, parseToolResult as parse, SMOKE_TYPE } from './fixtures.js';

/**
 * record_query list-mode selectors that reached the tool surface in 0.17.0:
 * `folderId` (every record in a folder, any type) and `recent` (the account-wide
 * recently-updated feed). Both have been on `GET /v1/records` for many releases;
 * only the MCP tool lacked them.
 *
 * Worth a wire test rather than a mock, for one specific reason: `recent` is a
 * STRING query parameter server-side while the tool takes a boolean, and
 * `folderId` changes which of three mutually-exclusive list modes the endpoint
 * selects. A mapping mistake in either would not error — it would quietly return
 * a DIFFERENT result set (an unfiltered feed, or a type listing), which is the
 * failure shape a mock cannot catch and an agent cannot detect.
 *
 * This also closes the loop the 0.43.0 folder-delete change opened: a folder that
 * still holds records refuses to delete, and this is the call that finds them.
 */

test('record_query lists by folderId and serves the recent feed', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  const stamp = Date.now();
  const { client, close } = await spawnServer();
  let folderId: string | undefined;
  let recordId: string | undefined;

  try {
    const folder = parse(
      await client.callTool({
        name: 'folder_create',
        arguments: { name: `mcp-smoke-rq-${stamp}` },
      }),
    );
    folderId = folder.id as string;
    assert.ok(folderId, `folder_create returned an id: ${JSON.stringify(folder)}`);

    const rec = parse(
      await client.callTool({
        name: 'record_create',
        arguments: {
          type: SMOKE_TYPE,
          fields: { title: 'InFolder', status: 'todo', rank: 'm60' },
          externalId: `smoke-rq-folder-${stamp}`,
          folderId,
        },
      }),
    );
    recordId = rec.id as string;
    assert.ok(recordId);

    // LIST BY FOLDER, with no `type` at all — the mode that did not exist before.
    const byFolder = parse(
      await client.callTool({ name: 'record_query', arguments: { folderId, limit: 100 } }),
    );
    assert.ok(Array.isArray(byFolder.data), `folder mode returns a page: ${JSON.stringify(byFolder)}`);
    assert.ok(
      (byFolder.data as Array<{ id?: string }>).some((r) => r.id === recordId),
      'the record filed into this folder is listed by folderId',
    );

    // type + folderId together — one type within one folder.
    const byTypeAndFolder = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, folderId, limit: 100 },
      }),
    );
    assert.ok(
      (byTypeAndFolder.data as Array<{ id?: string }>).some((r) => r.id === recordId),
      'type + folderId narrows to that type within that folder',
    );

    // RECENT — the account-wide feed. Assert the SHAPE and that it is not silently
    // the folder listing: it must be answerable with no type and no folder, and it
    // spans the account rather than this folder.
    const recent = parse(await client.callTool({ name: 'record_query', arguments: { recent: true, limit: 25 } }));
    assert.ok(Array.isArray(recent.data), `recent mode returns a page: ${JSON.stringify(recent)}`);
    assert.ok((recent.data as unknown[]).length > 0, 'the account has records, so the feed is non-empty');
    // Guard against the assertion being satisfiable by a plain type listing. The discriminator
    // has to be STRUCTURAL, not corpus-based: this suite is seeding-tolerant, and the staging
    // tenant can legitimately hold a single record of one type, so "the feed spans types" is not
    // assertable here. What is: the call names NO type and still returns rows — record_query
    // requires exactly one of type/folderId/recent, so a type listing cannot produce this at all.
    // Plus the row shape, and newest-first ordering whenever there is more than one row to order.
    const rows = recent.data as Array<{ id?: string; typeName?: string; updatedAt?: string; createdAt?: string }>;
    assert.ok(
      rows.every((r) => typeof r.typeName === 'string' && r.typeName.length > 0),
      `every row carries its own typeName: ${JSON.stringify(rows.map((r) => r.typeName))}`,
    );
    assert.ok(
      rows.some((r) => r.id === recordId),
      'the record this spec just created is in the account-wide feed',
    );
    const stamps = rows
      .map((r) => Date.parse(r.updatedAt ?? r.createdAt ?? ''))
      .filter((n) => !Number.isNaN(n));
    if (stamps.length > 1) {
      assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), 'the recent feed is newest-first');
    }

    // The rejections must come from the tool, not from a surprising server answer.
    const bothModes = await client.callTool({
      name: 'record_query',
      arguments: { recent: true, folderId },
    });
    assert.equal(bothModes.isError, true, 'recent + folderId is refused rather than silently resolved');
  } finally {
    await close();
    if (recordId) await api('DELETE', `/v1/records/${recordId}`).catch(() => {});
    // The folder must be emptied before it will delete — which is the very refusal
    // that made listing records by folder load-bearing in the first place.
    if (folderId) await api('DELETE', `/v1/folders/${folderId}`).catch(() => {});
  }
});
