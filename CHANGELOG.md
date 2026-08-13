# Changelog — Vectros examples

All notable changes to the Vectros examples are documented here. This project
adheres to [Semantic Versioning](https://semver.org). The version below is the
release version of this examples collection; each language example pins a
published Vectros SDK independently.

## 0.14.0 — 2026-08-12

Examples repinned to **Vectros SDK 0.39.0**. The TypeScript examples pin
`@vectros-ai/sdk@^0.39.0` (was `^0.38.0`); the Python range moves to
`vectros>=0.39.0,<0.40.0`; the Java example now pins `ai.vectros:vectros-sdk:0.39.0`.

### Added

- **`AuthSmokeTest` (Java), `test_auth.py` (Python), and the TypeScript identity
  example now cover 0.39.0's scoped-token TTL cap and credential-id semantics** —
  minting a token with `expiresInSeconds` above 3600 (1 hour) is rejected, and
  a token's reported `principalKeyId` is unique per mint (it's the token's own
  JWT id, not the identity it's bound to).

- **New coverage across all three languages for the trusted BYO-IdP issuer
  registry and RFC 8693 token exchange** — the full issuer-registry CRUD
  contract, every request-validation and routing rejection `exchange()` can
  produce, and a real 401 against a genuine public JWKS with an unverifiable
  signature.

- **New coverage for user-invitation validation** (email frozen while an
  invite is outstanding; an access-profile `roleId` must name an existing
  role), **composite-lookup declare-time refusals** (the schema-authoring
  rules a composite lookup must satisfy), and **`exists-by-email` +
  `AccessProfileResponse.email`**.

## 0.13.0 — 2026-08-05

Examples updated for **Vectros SDK 0.38.0**. The TypeScript examples pin
`@vectros-ai/sdk@^0.38.0` (was `^0.37.0`); the Python range moves to
`vectros>=0.38.0,<0.39.0`; the Java example now pins `ai.vectros:vectros-sdk:0.38.0`.
This release adds coverage for composite lookups — 0.38.0's headline feature — the
new `data_scope` placement matchers, the `sortFrom`/`sortTo` lookup window, and the
`Vectros-Version` request header, plus a search-consistency example for record
updates.

### Fixed

- **The Java quickstart's published Maven coordinate had drifted from the SDK its
  own source was tested against.** The public coordinate stayed pinned at
  `ai.vectros:vectros-sdk:0.29.9` while the internal harness this example is
  generated from moved forward to `0.33.0` and then `0.34.0` — a gap of four to
  five minor versions across every release from `examples-v0.7.0` through
  `v0.12.0`. The coordinate now tracks the SDK the example is actually written
  and verified against.

### Added

- **Composite lookups (`composite-lookup`, TypeScript; `CompositeLookupSmokeTest`,
  Java)** — a schema declares a lookup over two fields at once (`fieldNames` in
  place of `fieldName`), queried with `field=status,area` plus the new `values`
  parameter. Covers a fully-specified match, a partial tuple (fewer values than
  declared, grouped by the field(s) left unspecified), the POST body form, the
  `sortFrom`/`sortTo` sort-key window on a fully-specified tuple, and the
  array-typed `values` parameter's wire encoding — verified with a value that
  itself contains a comma.
- **`data_scope` placement matchers (`auth`)** — two new cases mint a scoped token
  using `${{ under.self.scope.<namespace> }}` (work with entities one level under
  your own without enumerating them) and the `"*"` dimension wildcard (one clause
  covering every ownership dimension at once).
- **`Vectros-Version` request header (`vectros-version-header`)** — a new example
  sends the header explicitly (the SDKs don't send it themselves yet), confirms it
  is echoed back on a supported version, and that an unrecognized version is
  rejected with `400 UNSUPPORTED_WIRE_VERSION`.
- **`records-update-consistency`** — an update makes the new content searchable
  and the old content stops surfacing, with no window where search shows stale or
  missing content.

## 0.12.0 — 2026-07-26

Examples updated for **Vectros SDK 0.37.0**. The TypeScript examples pin
`@vectros-ai/sdk@^0.37.0` (was `^0.36.0`); Python, Java, and CLI pin their SDKs
independently. This release adds coverage for `basedOn` schema customization
and its supporting fields, and rounds out the search response fields 0.37.0
completes.

### Added

- **`basedOn` schema customization (`schema-lineage`)** — a new example shows the full
  lifecycle: the first schema under a type name has no `basedOn` and becomes that name's
  shared base; a second schema of the same name is rejected unless it declares `basedOn`
  against the base; a schema that does declare it becomes a customization owned by a user
  or a scope. `GET /v1/schemas?recordType=` and creating a record by type name alone both
  resolve to the caller's own customization when one exists, otherwise the shared base.
- **`specificityRank` on scope namespaces (`schema-lineage`)** — a new case registers a
  custom namespace with an explicit `specificityRank` (required on every custom namespace
  now) and shows the tie-break it exists for: when a caller holds two scope dimensions at
  once, the higher-ranked one's customization wins.
- **`userId`/`scope` selectors on document lookup (`schema-lineage`)** — a new case shows a
  root API key resolving a lookup field as a specific user would, reaching a customization
  that declares a field the shared base doesn't.
- **Context-targeted token minting (`cross-context-isolation`, `app-contexts`)** — the
  cross-context examples now show how a root API key seeds the first schema of a type in a
  context other than its own: mint a token targeting that context with no bound user, then
  create the schema with it.
- **`externalId` and `hasMore` on search hits (`search`)** — new cases show a search result
  carrying the matched item's `externalId`, and the explicit `hasMore` flag that tells you
  whether another page of results is available.

### Changed

- **Search `limit` now reaches its full 1–100 range (`search`)** — a new case with more
  than 50 matching records confirms a `limit` above 50 now returns them all, instead of
  silently capping at 50.
- **TEXT-mode search hits carry a real `textScore` (`search`)** — a new assertion confirms
  keyword-mode results are ranked (`textScore > 0`), not the placeholder `0` every hit
  previously carried.

## 0.11.0 — 2026-07-22

Examples updated for **Vectros SDK 0.36.0**. The TypeScript examples pin
`@vectros-ai/sdk@^0.36.0` (was `^0.35.0`); Python, Java, and CLI pin their SDKs
independently. This release adapts the examples to the behavior 0.36.0 changed
and adds coverage for its new fields.

### Added

- **Large whole numbers as strings (`type-fidelity`)** — a new case shows that a value
  near 2^63 is stored byte-exact when sent to a `string` field. This is the pattern to
  use now that every number must fall within the signed 64-bit range: an out-of-range
  value in a `number` field is refused with a `400`, and a large whole number kept as a
  string stores exactly and supports exact-match lookup.
- **Activity-log `requestId` and `errorCode` (`logs`)** — the log-viewer example now reads
  the per-call `requestId` (the id to quote to support, the same one returned in an error
  body) and, on a failure rejected with a typed reason, branches on `errorCode` rather than
  matching the message text.
- **Identity surface in the log `resource` filter (`logs`)** — a new case seeds an
  identity-entity create and filters `GET /v1/admin/logs` by `resource: 'entities'` — the
  identity surface, now documented alongside `namespaces`. The legacy `orgs`/`clients`
  filters remain accepted for rows written before those surfaces were folded into `entities`.
- **Scoped-token idempotent create-or-get (`identity`)** — two new cases mint a real scoped
  token instead of using the root key: one shows a `users:c`+`users:r` token completing an
  idempotent create-retry, the other shows a `users:c`-only token correctly receiving an
  "already in use" error rather than the existing user's data, since being handed back an
  existing item on a collision is a read of that item and needs the paired read scope.

### Changed

- **Access-profile identity overrides reference real entities (`access-profiles`)** — override
  values are now authorized like scopes. The example seeds real `org`/`client` entities and
  overrides to their ids; a companion case shows that an override to a nonexistent entity is
  refused with a `400`.
- **Structured index failures (`indexFailure`)** — the record/document index-poll helpers now
  surface `indexFailure.code` (a stable, branchable reason such as `VECTOR_LIMIT_EXCEEDED` or
  `EMBEDDING_FAILED`) instead of a bare "failed" message when indexing fails.

## 0.10.1 — 2026-07-20

### Fixed

- **TypeScript examples README** — the `identity` row described the example as covering
  "Clients, organizations, and users". The example itself moved to the namespaced
  identity-entity surface in 0.10.0; the description had not. It now reads "Users and
  namespaced identity entities (`org`/`client`); parent ownership via `scopes`", matching
  what the example demonstrates.

## 0.10.0 — 2026-07-18

### Added

- **Type fidelity (`type-fidelity`)** — a new example proving that a schema's declared field types
  survive the full round-trip across records, identity entities, and documents: a `number` reads back
  as a number (not `"30"`) and a `boolean` as a boolean on the create response, a GET, and a list page;
  a resource stays updatable after create (a partial update never fails validation against an untouched
  typed field, and that field keeps its type); an identical no-op upsert cuts no new version; and a
  large payload field is preserved intact across a partial update.

### Changed

- **Identity examples migrated to the generic entities API** — the identity examples now use the
  namespaced `POST /v1/entities/{namespace}` surface. The previous `/v1/orgs` and `/v1/clients`
  routes and their `orgId`/`clientId` fields are retired: `org` and `client` are now two built-in
  namespaces of a single generic entity type. `identity` creates, reads, updates, lists, and deletes
  entities via `createEntity`/`getEntity`/`updateEntity`/`listEntities`/`deleteEntity` (with
  `namespace: 'org'` or `'client'`), expresses a client's parent org as a `scopes: ['org:<id>']`
  edge, and lists an org's clients with `?scope=org:<id>`.
- **Ownership is authored through `scopes` everywhere** — the record, document, and folder examples
  (`records`, `records-archive`, `documents-text`, `documents-upload`, `folders`) now set ownership
  with a `scopes: ['org:<id>']` array instead of the retired `orgId` field, and read it back from the
  response `scopes` list. Owner-narrowed listing and search use `?scope=namespace:value`, and a
  scoped token's data scope is keyed by `scope:<namespace>` — for example
  `dataScope: { 'scope:org': ['<id>'] }`.
- **Access-profile identity overrides (`access-profiles`)** — `identityOverrides` are now keyed by
  `scope:<namespace>` (`scope:org`, `scope:client`, or any namespace you register) rather than the
  retired `orgId`/`clientId` keys.
- **TypeScript examples SDK pin** — bumped `@vectros-ai/sdk` from `^0.34.0` to `^0.35.0` to track the
  release that introduces the generic identity-entity surface. This is a breaking API change: the
  older identity routes and fields are no longer available.

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
  enforcement: retrieval now returns only content the token could read directly, so the
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
