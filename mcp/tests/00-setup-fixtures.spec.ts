import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recreateSmokeSchema, seedSmokeDocument, SMOKE_TYPE } from './fixtures.js';

/**
 * Fixture setup — runs FIRST (the suite executes `--test-concurrency=1` in filename
 * order, so a `00-` spec precedes every other). It deterministically provisions the
 * shared fixtures so the specs that follow consume known, correctly-shaped data instead
 * of discovering it from the live catalog and skipping when it's absent:
 *   • the `mcp_smoke_record` schema (status = equality, rank = range) + a seeded record
 *     — for 10 (record_query), 11 (lifecycle), 12 (record hybrid_search);
 *   • a seeded, INDEXED document — for 06 (document_get, direct + search→get).
 *
 * Recreating the schema each run also exercises the delete -> recreate path and keeps the
 * migration-locked lookup shape clean across runs.
 */
test('setup: provision the mcp_smoke_record schema + record, and an indexed document', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }
  const schema = await recreateSmokeSchema();
  if (schema === 'forbidden') {
    // The key genuinely lacks scope to provision (e.g. a non-root smoke key) — a real
    // precondition, not an arbitrary skip. The dependent specs skip on the same 403.
    t.skip('smoke key cannot provision schemas (non-root) — record/document specs will skip');
    return;
  }
  assert.equal(schema, 'provisioned', `record fixture provisioned for ${SMOKE_TYPE}`);

  const doc = await seedSmokeDocument();
  assert.equal(doc, 'provisioned', 'document fixture provisioned (seeded + indexed)');
});
