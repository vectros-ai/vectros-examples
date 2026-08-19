import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSmokeEntityNamespace, recreateSmokeSchema, seedSmokeDocument, SMOKE_TYPE } from './fixtures.js';

/**
 * Fixture setup — runs FIRST (the suite executes `--test-concurrency=1` in filename
 * order, so a `00-` spec precedes every other). It deterministically provisions the
 * shared fixtures so the specs that follow consume known, correctly-shaped data instead
 * of discovering it from the live catalog and skipping when it's absent:
 *   • the `mcp_smoke_record` schema (status = equality, rank = range) + a seeded record
 *     — for 10 (record_query), 11 (lifecycle), 12 (record hybrid_search);
 *   • a seeded, INDEXED document — for 06 (document_get, direct + search→get);
 *   • the `client` namespace, registered entity-backed — for 15 (lookup_principal). API
 *     0.40.0 dropped `org`/`client`'s special-cased auto-provisioning: every namespace now
 *     needs an explicit registration before an entity can be created in it, same as any
 *     namespace you register yourself.
 *
 * Recreating the schema each run also exercises the delete -> recreate path and keeps the
 * migration-locked lookup shape clean across runs.
 */
test('setup: provision the mcp_smoke_record schema + record, an indexed document, and the client namespace', async (t) => {
  if (!process.env.VECTROS_API_KEY) {
    t.skip('VECTROS_API_KEY not set');
    return;
  }

  // Three INDEPENDENT preconditions — schema/document provisioning is gated by an ordinary
  // scope check; namespace registration is gated by a narrower one (root or a bootstrap-only
  // capability), so a scoped (non-root) key can hold one without the other. Attempt every one
  // regardless of an earlier 'forbidden', so a missing scope never silently skips an UNRELATED
  // fixture (chaining them behind each other's early return did exactly that). Each dependent
  // spec (06/10/11/12/15) checks its own fixture's presence rather than trusting this test's
  // pass/skip status.
  const forbidden: string[] = [];

  const schema = await recreateSmokeSchema();
  if (schema === 'forbidden') {
    forbidden.push('schema (record/document specs depending on it will skip)');
  } else {
    assert.equal(schema, 'provisioned', `record fixture provisioned for ${SMOKE_TYPE}`);
  }

  const doc = await seedSmokeDocument();
  if (doc === 'forbidden') {
    forbidden.push('document (document_get specs will skip)');
  } else {
    assert.equal(doc, 'provisioned', 'document fixture provisioned (seeded + indexed)');
  }

  const namespace = await ensureSmokeEntityNamespace();
  if (namespace === 'forbidden') {
    forbidden.push("namespace (lookup_principal's contextId spec will skip)");
  } else {
    assert.equal(namespace, 'provisioned', "'client' namespace registered entity-backed");
  }

  if (forbidden.length === 3) {
    t.skip(`smoke key cannot provision any fixture (non-root): ${forbidden.join('; ')}`);
  }
});
