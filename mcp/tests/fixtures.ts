/**
 * Shared record-fixture for the record/schema MCP smoke specs.
 *
 * `mcp_smoke_record` is a SHARED fixture: specs 10 (discovery-free record_query)
 * and 11 (the write lifecycle) import these helpers; spec 12's record-scoped
 * hybrid_search relies on the schema existing but references the type by literal
 * (it doesn't import here). The `00-setup-fixtures` spec RECREATES it deterministically before any of
 * them run — the suite executes `--test-concurrency=1` in filename order, so a
 * `00-` spec is guaranteed to run first. Consuming specs therefore rely on a
 * known, correctly-shaped fixture instead of discovering one from the live
 * catalog and skipping when it's absent (a skipped test asserts nothing).
 *
 * Shape: ONE equality lookup field (`status` → a GSI slot) and ONE range-enabled
 * lookup field (`rank` → a range row, serving prefix + range lookups). We use a
 * PURPOSE-BUILT range field rather than converting `status`, because `rangeEnabled`
 * is migration-locked once a field is first declared (it picks GSI-slot vs range-row
 * and cannot change, even via remove + re-add). Recreating the schema each run keeps
 * both the shape and that lock ledger deterministic.
 */

const BASE = (process.env.VECTROS_API_BASE_URL ?? 'https://api.vectros.ai').replace(/\/$/, '');
const KEY = process.env.VECTROS_API_KEY;

export const SMOKE_TYPE = 'mcp_smoke_record';
export const SMOKE_EQUALITY_FIELD = 'status'; // equality lookup (GSI slot)
export const SMOKE_RANGE_FIELD = 'rank'; // range + prefix lookup (range row, rangeEnabled)
export const SMOKE_COMPOSITE_FIELD_2 = 'area'; // second leg of the composite (status,area) lookup

export const SMOKE_SCHEMA = {
  typeName: SMOKE_TYPE,
  displayName: 'MCP smoke record',
  allowedSurfaces: ['record'],
  indexMode: 'HYBRID',
  fields: [
    { fieldId: 'title', fieldType: 'string', required: true, searchable: true },
    { fieldId: SMOKE_EQUALITY_FIELD, fieldType: 'string', filterable: true },
    { fieldId: SMOKE_RANGE_FIELD, fieldType: 'string' },
    { fieldId: SMOKE_COMPOSITE_FIELD_2, fieldType: 'string' },
    { fieldId: 'note', fieldType: 'string' },
  ],
  lookupFields: [
    { fieldName: SMOKE_EQUALITY_FIELD }, // equality
    { fieldName: SMOKE_RANGE_FIELD, rangeEnabled: true }, // range + prefix
    // Composite (SDK 0.38): a separate, independently-indexed lookup over BOTH fields
    // together — declared alongside, not instead of, the single-field one above.
    { fieldNames: [SMOKE_EQUALITY_FIELD, SMOKE_COMPOSITE_FIELD_2] },
  ],
};

export interface ApiResult {
  status: number;
  json: any;
}

/** Raw API call with the smoke root key. Schema/record management isn't an MCP tool. */
export async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/**
 * Parse an MCP tool result's first text block as JSON — but if the tool returned
 * `isError: true`, the text is a human-readable error message (NOT JSON), so SURFACE
 * it. Blindly `JSON.parse`-ing an error result throws an opaque "Unexpected token"
 * SyntaxError that hides the real cause (e.g. a backend 400 that says exactly what's
 * wrong); the server passes the backend message through verbatim — don't swallow it.
 */
export function parseToolResult(result: {
  // `client.callTool()` returns a compatibility UNION: the modern `CallToolResult`
  // (with `content`) OR the legacy `{ toolResult }` shape (without). So `content` is
  // optional, each `content` block is itself a union (text/image/resource/…) → `text`
  // is per-block optional, and the index signature both accepts the legacy branch's
  // own `[x: string]: unknown` and avoids weak-type detection rejecting it (an
  // all-optional type would error: "no properties in common"). The modern server
  // always returns the `content` branch — a missing/empty text block falls through to
  // `JSON.parse('')`, which throws loudly rather than passing silently.
  content?: ReadonlyArray<{ type: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
}): any {
  const text = (result.content?.[0]?.text ?? '') as string;
  if (result.isError) throw new Error(`MCP tool returned an error result:\n${text}`);
  return JSON.parse(text);
}

async function findSmokeSchema(): Promise<{ id: string } | undefined> {
  let cursor: string | undefined;
  do {
    const q = cursor ? `?limit=100&startFrom=${encodeURIComponent(cursor)}` : '?limit=100';
    const { json } = await api('GET', `/v1/schemas${q}`);
    const hit = (json?.data ?? []).find((s: { typeName?: string }) => s.typeName === SMOKE_TYPE);
    if (hit) return hit as { id: string };
    cursor = json?.nextCursor ?? undefined;
  } while (cursor);
  return undefined;
}

/** Drain all records of the smoke type — deleteSchema 409s while records exist. Records are throwaway. */
async function deleteAllSmokeRecords(): Promise<void> {
  for (let guard = 0; guard < 1000; guard++) {
    const { json } = await api('GET', `/v1/records?type=${encodeURIComponent(SMOKE_TYPE)}&limit=100`);
    const rows = (json?.data ?? []) as Array<{ id: string }>;
    if (rows.length === 0) return;
    for (const r of rows) await api('DELETE', `/v1/records/${r.id}`);
  }
  throw new Error('deleteAllSmokeRecords: did not drain within the guard limit');
}

export type FixtureOutcome = 'provisioned' | 'forbidden';

/** 403 -> 'forbidden'; outside [200,300) -> throw a formatted error naming `what`; otherwise undefined (caller proceeds). */
function assertCreated(result: ApiResult, what: string): FixtureOutcome | undefined {
  if (result.status === 403) return 'forbidden';
  if (result.status < 200 || result.status >= 300)
    throw new Error(`${what} failed: HTTP ${result.status} ${JSON.stringify(result.json)}`);
  return undefined;
}

// ── Namespace fixture ────────────────────────────────────────────────────────
// API 0.40.0: `org`/`client` lost their special-cased auto-provisioning — every namespace,
// `org`/`client` included, now needs an explicit `POST /v1/namespaces` registration (choosing
// `entityBacked`) before `POST /v1/entities/{namespace}` will accept a create. Pre-0.40.0 this
// fixture didn't exist because it didn't need to.
const SMOKE_ENTITY_NAMESPACE = 'client';
// Any value in [0, 1_000_000] unused by this tenant works; 2000 is what a real account-creation
// auto-provision picks for `client` today, so reusing it here can never collide with one landing
// later — registering an already-registered namespace is a no-op there, whoever registered it.
// `specificityRank` IS unique tenant-wide across every namespace though, so an unrelated one on
// this shared tenant could still collide on this exact value — see the 400 branch below for how
// that surfaces.
const SMOKE_ENTITY_NAMESPACE_RANK = 2000;

/**
 * Register `client` as entity-backed if it isn't already (idempotent: a repeat `POST` on an
 * already-registered namespace 400s, so check first — same find-then-skip-if-found shape as
 * `seedSmokeDocument`, not `recreateSmokeSchema`, which unconditionally recreates regardless of
 * what it finds). Returns 'forbidden' if the key can't register namespaces.
 */
export async function ensureSmokeEntityNamespace(): Promise<FixtureOutcome> {
  const existing = await api('GET', `/v1/namespaces/${SMOKE_ENTITY_NAMESPACE}`);
  if (existing.status === 200) return 'provisioned';
  if (existing.status !== 404)
    throw new Error(`GET namespace '${SMOKE_ENTITY_NAMESPACE}' failed: HTTP ${existing.status} ${JSON.stringify(existing.json)}`);

  const create = await api('POST', '/v1/namespaces', {
    namespace: SMOKE_ENTITY_NAMESPACE,
    entityBacked: true,
    specificityRank: SMOKE_ENTITY_NAMESPACE_RANK,
  });
  if (create.status === 400) {
    // Two known causes, both handled here rather than left as an opaque crash:
    //  - TOCTOU: a concurrent run registered `client` between our GET and this POST (this file has
    //    no locking against a shared tenant — same accepted risk shape as recreateSmokeSchema's own
    //    find-then-write below). Re-check rather than assume; if it's there now, the race resolved
    //    itself and this isn't a real failure.
    //  - A genuine specificityRank collision: SMOKE_ENTITY_NAMESPACE_RANK reuses the platform's own
    //    default rank for `client` precisely so it can't collide with a REAL auto-provision landing
    //    later, but the rank is unique tenant-wide, so an unrelated namespace already at 2000 on this
    //    shared tenant would still 400 here. Re-check stays 404 in that case; surface the likely cause
    //    explicitly instead of leaving the reader to decode the raw JSON body.
    const recheck = await api('GET', `/v1/namespaces/${SMOKE_ENTITY_NAMESPACE}`);
    if (recheck.status === 200) return 'provisioned';
    throw new Error(
      `register namespace '${SMOKE_ENTITY_NAMESPACE}' failed: HTTP 400 ${JSON.stringify(create.json)} — ` +
        `if this names 'specificityRank', another namespace on this tenant already holds rank ` +
        `${SMOKE_ENTITY_NAMESPACE_RANK}; pick a different SMOKE_ENTITY_NAMESPACE_RANK.`,
    );
  }
  const outcome = assertCreated(create, `register namespace '${SMOKE_ENTITY_NAMESPACE}'`);
  return outcome ?? 'provisioned';
}

/**
 * Recreate the smoke schema from scratch — drain its (throwaway) records → deleteSchema →
 * create fresh with the intended shape → seed one record. Deterministic shape every run,
 * and a clean migration-lock ledger (the old schema, with any prior lookup-field shape, is
 * gone). Returns 'forbidden' if the key genuinely lacks scope to provision (a real
 * precondition — not an arbitrary skip); throws on any other failure (loud, not silent).
 */
export async function recreateSmokeSchema(): Promise<FixtureOutcome> {
  const existing = await findSmokeSchema();
  if (existing) {
    await deleteAllSmokeRecords();
    const del = await api('DELETE', `/v1/schemas/${existing.id}`);
    if (del.status === 403) return 'forbidden';
    if (del.status !== 204 && del.status !== 200 && del.status !== 404)
      throw new Error(`deleteSchema failed: HTTP ${del.status} ${JSON.stringify(del.json)}`);
  }
  const create = await api('POST', '/v1/schemas', SMOKE_SCHEMA);
  const createOutcome = assertCreated(create, 'createSchema');
  if (createOutcome) return createOutcome;
  // Seed one record so record_query list/lookup specs assert against real data (record
  // reads are immediate; hybrid_search indexing is async, but the search spec tolerates
  // an empty result, so we don't block on INDEXED here).
  const seed = await api('POST', '/v1/records', {
    typeName: SMOKE_TYPE,
    externalId: 'mcp-smoke-seed',
    payload: { title: 'Seed', status: 'open', rank: 'm50', area: 'general', note: 'seed' },
  });
  if (seed.status < 200 || seed.status >= 300)
    throw new Error(`seed record failed: HTTP ${seed.status} ${JSON.stringify(seed.json)}`);
  return 'provisioned';
}

// ── Document fixture ─────────────────────────────────────────────────────────
// A deterministic, INDEXED document so the document_get specs (06) can exercise both
// a direct get-by-id AND a search→get path without depending on incidental corpus
// state (and without falsely passing on a record hit). Idempotent by externalId.
//
// This fixture seeds via the raw API because schema/record/document MANAGEMENT for the
// fixture is centralized here, not because the MCP tool can't — `document_ingest` now
// exposes `externalId` too (idempotent ingest), exercised by the 14-document-ingest-externalId spec.
export const SMOKE_DOC_EXTERNAL_ID = 'mcp-smoke-seed-doc';
const SMOKE_DOC_TITLE = 'MCP smoke seed document';
const SMOKE_DOC_TEXT =
  'A seeded smoke document about the Vectros developer platform: hybrid search, ' +
  'structured records, retrieval-augmented generation, and document ingestion. It ' +
  'exists so the document_get specs have a deterministic, indexed document to exercise.';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function findSmokeDocument(): Promise<{ id: string; indexStatus?: string } | undefined> {
  let cursor: string | undefined;
  do {
    const q = cursor ? `?limit=100&startFrom=${encodeURIComponent(cursor)}` : '?limit=100';
    const { json } = await api('GET', `/v1/documents${q}`);
    const hit = (json?.data ?? []).find((d: { externalId?: string }) => d.externalId === SMOKE_DOC_EXTERNAL_ID);
    if (hit) return hit as { id: string; indexStatus?: string };
    cursor = json?.nextCursor ?? undefined;
  } while (cursor);
  return undefined;
}

/** Resolve the seeded smoke document's id (provisioned by 00-setup). undefined if absent. */
export async function resolveSmokeDocumentId(): Promise<string | undefined> {
  return (await findSmokeDocument())?.id;
}

/**
 * Seed the smoke document (idempotent by externalId) and wait until it is INDEXED so the
 * search→get path in 06 is deterministic. Direct get-by-id works immediately regardless,
 * so the INDEXED wait is best-effort (bounded): returns 'provisioned' even if indexing
 * lags past the budget. Returns 'forbidden' if the key can't ingest.
 */
export async function seedSmokeDocument(): Promise<FixtureOutcome> {
  let doc = await findSmokeDocument();
  if (!doc) {
    const ingest = await api('POST', '/v1/documents', {
      title: SMOKE_DOC_TITLE,
      externalId: SMOKE_DOC_EXTERNAL_ID,
      text: SMOKE_DOC_TEXT,
      indexMode: 'HYBRID',
    });
    const ingestOutcome = assertCreated(ingest, 'seed document');
    if (ingestOutcome) return ingestOutcome;
    doc = ingest.json as { id: string; indexStatus?: string };
  }
  const id = doc.id;
  // The processing axis is `indexStatus` (the caller lifecycle is `status`).
  for (let i = 0; i < 30; i++) {
    if (doc.indexStatus === 'INDEXED') break;
    await sleep(1000);
    const { json } = await api('GET', `/v1/documents/${id}`);
    doc = json as { id: string; indexStatus?: string };
  }
  return 'provisioned';
}
