import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse, SMOKE_TYPE, SMOKE_EQUALITY_FIELD, SMOKE_COMPOSITE_FIELD_2 } from './fixtures.js';

/**
 * record_query composite-lookup smoke (SDK 0.38) — `values` (a lookup declared
 * over `status,area`) and `sortFrom`/`sortTo`, against the shared
 * `mcp_smoke_record` fixture's composite lookup field.
 *
 * Creates and tears down its own three records here (distinct status/area
 * combinations) rather than relying on the single 00-setup seed, since a
 * composite lookup needs more than one distinguishable combination to prove
 * it's actually matching on BOTH fields, not just one.
 */

test('record_query composite lookup (values) + sortFrom/sortTo', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const { client, close } = await spawnServer();
  const stamp = Date.now();
  const ids: string[] = [];
  try {
    const create = async (status: string, area: string, externalId: string) => {
      const created = parse(
        await client.callTool({
          name: 'record_create',
          arguments: {
            type: SMOKE_TYPE,
            fields: { title: 'Composite smoke', status, area, rank: 'm50' },
            externalId,
          },
        }),
      );
      assert.ok(created.id, `create returned an id: ${JSON.stringify(created)}`);
      ids.push(created.id as string);
      return created.id as string;
    };

    // status=open/area=billing (x2 — a TIED composite key, deliberately: a grouped or
    // full-tuple match must return BOTH, not silently collapse to one), status=open/
    // area=support, status=closed/area=billing — enough to prove a composite match
    // narrows on BOTH legs, not just one, and that duplicate keys aren't lost.
    const openBilling = await create('open', 'billing', `smoke-composite-ob-${stamp}`);
    const openBillingTwin = await create('open', 'billing', `smoke-composite-ob2-${stamp}`);
    const openSupport = await create('open', 'support', `smoke-composite-os-${stamp}`);
    const closedBilling = await create('closed', 'billing', `smoke-composite-cb-${stamp}`);

    // Full tuple — matches BOTH records sharing that exact key, not just one.
    const full = parse(
      await client.callTool({
        name: 'record_query',
        arguments: {
          type: SMOKE_TYPE,
          field: `${SMOKE_EQUALITY_FIELD},${SMOKE_COMPOSITE_FIELD_2}`,
          values: ['open', 'billing'],
          limit: 100,
        },
      }),
    );
    const fullRecords = full.data as Array<{ id: string; createdAt?: string }>;
    const fullIds = fullRecords.map((r) => r.id);
    assert.ok(fullIds.includes(openBilling), 'full composite match finds the open+billing record');
    assert.ok(fullIds.includes(openBillingTwin), 'and its tied-key twin — a duplicate key is not collapsed/lost');
    assert.ok(!fullIds.includes(openSupport), 'does not match on status alone');
    assert.ok(!fullIds.includes(closedBilling), 'does not match on area alone');

    // Derived from the result above, not asserted timing: the latest `createdAt` of
    // the two matched records, used below to build a sortFrom/sortTo window that
    // actually EXCLUDES something — proving the bound is applied, not just accepted.
    const openBillingCreatedAt = fullRecords.find((r) => r.id === openBilling)?.createdAt;
    const openBillingTwinCreatedAt = fullRecords.find((r) => r.id === openBillingTwin)?.createdAt;
    assert.ok(openBillingCreatedAt, 'full-tuple result includes createdAt for openBilling');
    assert.ok(openBillingTwinCreatedAt, 'full-tuple result includes createdAt for openBillingTwin');
    const bothCreatedAtMs = Math.max(Date.parse(openBillingCreatedAt!), Date.parse(openBillingTwinCreatedAt!));

    // Partial tuple (leading run only) — groups by the unspecified field, so all
    // three open records come back (incl. both halves of the tied key) regardless
    // of area; the closed one is excluded.
    const partial = parse(
      await client.callTool({
        name: 'record_query',
        arguments: {
          type: SMOKE_TYPE,
          field: `${SMOKE_EQUALITY_FIELD},${SMOKE_COMPOSITE_FIELD_2}`,
          values: ['open'],
          limit: 100,
        },
      }),
    );
    const partialIds = (partial.data as Array<{ id: string }>).map((r) => r.id);
    assert.ok(partialIds.includes(openBilling), 'partial match includes open+billing');
    assert.ok(partialIds.includes(openBillingTwin), 'partial match includes its tied-key twin too');
    assert.ok(partialIds.includes(openSupport), 'partial match includes open+support');
    assert.ok(!partialIds.includes(closedBilling), 'partial match excludes the closed record');

    // sortFrom/sortTo plumbing, TWO windows so the check can actually fail if the
    // server silently ignores the bound rather than only proving it's accepted:
    //   1. wide-open (epoch 0 to far future) — must INCLUDE both matched records.
    //   2. narrow (starts one ms after the later of the two records' own createdAt)
    //      — must EXCLUDE both. A window that only ever includes everything can't
    //      distinguish "the window works" from "the window is ignored"; this one can.
    const wideWindow = parse(
      await client.callTool({
        name: 'record_query',
        arguments: {
          type: SMOKE_TYPE,
          field: `${SMOKE_EQUALITY_FIELD},${SMOKE_COMPOSITE_FIELD_2}`,
          values: ['open', 'billing'],
          sortFrom: '0',
          sortTo: '9999999999999',
          limit: 100,
        },
      }),
    );
    const wideWindowIds = (wideWindow.data as Array<{ id: string }>).map((r) => r.id);
    assert.ok(wideWindowIds.includes(openBilling), 'wide sortFrom/sortTo window includes the record');
    assert.ok(wideWindowIds.includes(openBillingTwin), 'and its tied-key twin');

    const narrowWindow = parse(
      await client.callTool({
        name: 'record_query',
        arguments: {
          type: SMOKE_TYPE,
          field: `${SMOKE_EQUALITY_FIELD},${SMOKE_COMPOSITE_FIELD_2}`,
          values: ['open', 'billing'],
          sortFrom: String(bothCreatedAtMs + 1),
          sortTo: '9999999999999',
          limit: 100,
        },
      }),
    );
    const narrowWindowIds = (narrowWindow.data as Array<{ id: string }>).map((r) => r.id);
    assert.ok(
      !narrowWindowIds.includes(openBilling),
      'a sortFrom set one ms after both records were created excludes openBilling — the window actually filters',
    );
    assert.ok(!narrowWindowIds.includes(openBillingTwin), 'and excludes its twin too');

    // Same discriminating-window check, but on the SDK's own primary documented use
    // ("Use with `value`") — a plain SINGLE-field equality lookup, not a composite.
    // Every other new sortFrom/sortTo test in this diff pairs it with `values`; this
    // is the one covering the non-composite case.
    const equalityWide = parse(
      await client.callTool({
        name: 'record_query',
        arguments: { type: SMOKE_TYPE, field: SMOKE_EQUALITY_FIELD, value: 'open', sortFrom: '0', limit: 100 },
      }),
    );
    const equalityWideIds = (equalityWide.data as Array<{ id: string }>).map((r) => r.id);
    assert.ok(equalityWideIds.includes(openBilling), 'wide window on a plain equality lookup includes the record');
    assert.ok(!equalityWideIds.includes(closedBilling), 'still excludes a non-matching status');

    const equalityNarrow = parse(
      await client.callTool({
        name: 'record_query',
        arguments: {
          type: SMOKE_TYPE,
          field: SMOKE_EQUALITY_FIELD,
          value: 'open',
          sortFrom: String(bothCreatedAtMs + 1),
          limit: 100,
        },
      }),
    );
    const equalityNarrowIds = (equalityNarrow.data as Array<{ id: string }>).map((r) => r.id);
    assert.ok(
      !equalityNarrowIds.includes(openBilling),
      'the same narrow bound excludes openBilling on the plain equality lookup too',
    );
    assert.ok(!equalityNarrowIds.includes(openBillingTwin), 'and its twin');

    // Mutual exclusion still enforced against the live server, not just the local schema.
    const badCombo = await client.callTool({
      name: 'record_query',
      arguments: {
        type: SMOKE_TYPE,
        field: SMOKE_EQUALITY_FIELD,
        value: 'open',
        values: ['open', 'billing'],
      },
    });
    assert.equal(badCombo.isError, true, "'value' and 'values' together is rejected");
  } finally {
    for (const id of ids) {
      await client.callTool({ name: 'record_delete', arguments: { id } });
    }
    await close();
  }
});
