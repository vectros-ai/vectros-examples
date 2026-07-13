# Changelog — Vectros examples

All notable changes to the Vectros examples are documented here. This project
adheres to [Semantic Versioning](https://semver.org). The version below is the
release version of this examples collection; each language example pins a
published Vectros SDK independently.

## 0.9.0 — 2026-07-12

### Added

- **Record archive lifecycle (`records-archive`)** — a new example walking a record through
  `ACTIVE → ARCHIVED → ACTIVE`: it creates a searchable record, archives it and confirms search
  no longer returns it, then reactivates it and confirms it is searchable again — while proving the
  record stays retrievable by id and listed by `GET /v1/records` the whole time (archive retracts
  from search only, never from storage).
- **Payload tiering + safe full-replacement (`records-tiering-safety`)** — shows how a large record
  payload is stored externally so a list/lookup returns only the indexed projection (flagged with
  `payloadPartial`), and how a `PUT` rebuilt from that projection is rejected rather than silently
  clearing the omitted fields. Demonstrates the three safe paths: `PATCH` to preserve omitted fields,
  `?includePayload=true` to read the full payload, and the `allowClear` confirmation to intentionally
  replace it.
- **Record TTL contract (`records-ttl`)** — sets an absolute `expiresAt` on a TTL-eligible schema and
  shows the validation contract: the schema opt-in requirement, the 10-minute floor, malformed-timestamp
  rejection, and that an upsert which only extends the expiry is applied, not treated as a no-op.
- **Filterable payload projection (`documents-filterable-projection`)** — shows that a large free-text
  field ingests and stays full-text searchable by body, that a schema field must be declared
  `filterable` to be usable as a `?filters=` target (free-text fields are content, not filters), and
  that an oversized declared-filterable value is rejected up front with a clear error.

### Changed

- **File-upload scopes (`documents-upload`)** — extended to show a file uploaded with `scopes`: the
  document carries them, and a scoped token confined to that scope sees the file in search while one
  outside it does not (parity with text ingest).
- **Folder + owner listing (`folders`)** — extended to show `GET /v1/records?folderId=&userId=`
  returning a record that also carries an `orgId`, and a fully-filtered folder feed resuming across
  pages via the cursor.

No SDK pin change — the new examples exercise record TTL / archive / payload-tiering and file-upload
scope ownership, all part of the `@vectros-ai/sdk@^0.34.0` surface already pinned in 0.8.4.

## 0.8.4 — 2026-07-10

### Changed

- **TypeScript examples SDK pin** — bumped the TypeScript examples' `@vectros-ai/sdk`
  dependency range from `^0.33.0` to `^0.34.0` to track the current SDK release
  (additive `scopes` read-back on record/document/folder responses, plus webhooks).
  No example behavior changes.

## 0.8.3 — 2026-07-10

### Added

- **Owner-scope search smoke (`search`)** — a new example proving that a scoped token whose data
  scope opts into tenant-level content (its owner list includes the `null` sentinel alongside its
  own id) sees **owner-less rows in both `TEXT` and `SEMANTIC` search**, together with its own rows,
  while another owner's rows stay excluded. It seeds the three ownership shapes (owner-less,
  self-owned, other-owned) through a root key, waits for indexing, searches through the scoped token,
  and cleans up every seeded row. No SDK pin change.

## 0.8.2 — 2026-07-09

### Changed

- **Models catalog smoke (`models`)** — refreshed for the current inference lineup: `GET /v1/models`
  now lists **Claude Sonnet 5** (replacing the retired `claude-sonnet-4-6` alias) and **Amazon Nova
  Lite**. The per-1k credit-rate assertion is now provider-aware — Anthropic models price output at
  5× input, Amazon Nova at 4× — so the mixed-provider catalog validates. No SDK pin change.

## 0.8.1 — 2026-07-09

### Changed

- **Scoped-token RAG example (`rag`)** — updated to the tightened search/RAG data-scope
  enforcement (#587): retrieval now returns only content the token could read directly, so the
  scoped-token RAG example grants `documents:r` alongside `inference:r`/`search:r`, and a new
  case shows a token with `inference:r`/`search:r` but no read grant grounds on nothing
  (fail-closed). No SDK pin change.

## 0.8.0 — 2026-07-08

Adds runnable TypeScript examples of app-context teardown and exact per-operation
billing. No SDK pin change (the TypeScript examples stay on `@vectros-ai/sdk@^0.33.0`).

### Added

- **App-context teardown (`app-contexts`)** — the TypeScript app-contexts example
  now demonstrates the confirm-gated context delete end to end: it seeds a context
  with real content (a schema, record, folder, and document), issues the delete with
  the required `confirm` echo (and shows the `400` when it is missing or wrong), then
  verifies the content is actually erased — each seeded item returns `404` after the
  delete, rather than only checking that the context reports `purging`.
- **Exact per-operation billing (`billing-exact`)** — a new TypeScript example that
  pins the precise credit cost of an operation: it snapshots `credits.usedMilli`
  before and after a minimal create + delete, showing the charge is exactly
  computable from the published pricing schedule (a write base plus one index
  charge, with deletes billed the same as writes).

## 0.7.0 — 2026-07-06

Examples updated for **Vectros SDK 0.33.0**, adding runnable examples for the
document behaviors introduced across 0.32–0.33. The TypeScript examples pin
`@vectros-ai/sdk@^0.33.0` (was `^0.31.0`).

### Added

- **File-upload text retention (`storeText`)** — a new TypeScript example
  (`documents-storetext`) showing an upload with `storeText: false` (the file is
  indexed and downloadable, but its extracted text is discarded after indexing —
  `/text` 404, `/ask` 409), the default-retain behavior, and that the choice is
  immutable after ingest.
- **File re-upload / re-index** — new TypeScript (`documents-reupload`) and MCP
  (`file-reupload-reindex`) examples that replace a file document's contents by
  re-uploading against the same external ID, re-extracting and re-indexing in place.
- **Document archive / restore** — a new MCP example
  (`document-archive-status`) that toggles a document's lifecycle `status`
  (`ARCHIVED` ↔ `ACTIVE`) to soft-retract and restore it.

### Changed

- **TypeScript** — pinned SDK range bumped `^0.31.0 → ^0.33.0`, and the existing
  document examples updated for the 0.33 request shape (`storeText` is no longer
  sent on text ingest — text bodies are always retained). Python, Java, and CLI
  examples pin their SDKs independently.

### Fixed

- **Cross-context example (Java, Python)** — the document-indexing wait now polls
  the processing `indexStatus` / `index_status` instead of the lifecycle `status`,
  so it no longer times out waiting for a value that field never reports.

## 0.6.0 — 2026-06-30

Examples updated for **Vectros SDK 0.31.0**. The TypeScript examples adopt the
0.31.0 request shape — body-only `create` calls now take a `{ body }` wrapper
(`createX({ body: { … } })`), a consequence of the SDK gaining the optional
`?upsert` parameter on those endpoints. The Python and Java examples are
unchanged (those SDKs kept their existing call shapes). Wire behavior is
identical; only the typed TypeScript call shape changed.

### Changed

- **TypeScript** (`@vectros-ai/sdk` 0.31.0) — body-only creates (`createRecord`,
  `createSchema`, `ingestDocument`, `createUser`, `createOrg`, `createClient`,
  `createFolder`, `createAppContext`) wrapped in `{ body }` per the regenerated
  client; `createScopedKey` (no body) unchanged.

## 0.5.0 — 2026-06-25

Runnable, end-to-end examples for the Vectros API in **TypeScript**, **Python**,
and **Java**, plus the **CLI** and the **MCP server**. Each example runs against
your own account with your own API key.

### Added

- **TypeScript** (`@vectros-ai/sdk`) — records, documents, folders, hybrid search,
  grounded RAG, streaming chat, identity & access, usage and cross-tenant
  reconciliation, and cross-context isolation.
- **Python** (`vectros`) — auth, streaming chat, response envelopes, the error
  contract, and cross-context isolation.
- **Java** (`ai.vectros:vectros-sdk`) — the same cross-language surface.
- **CLI** (`@vectros-ai/cli`) — an interactive walkthrough.
- **MCP server** (`@vectros-ai/mcp-server`) — tool examples over MCP stdio.
