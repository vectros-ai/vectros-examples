# Vectros TypeScript examples

End-to-end examples for the Vectros API using the official TypeScript SDK,
[`@vectros-ai/sdk`](https://www.npmjs.com/package/@vectros-ai/sdk). Each spec is
a real, runnable workflow with production-grade error handling, async patterns,
and cleanup.

## Run them

```bash
cp ../.env.example ../.env     # set VECTROS_API_KEY and VECTROS_API_BASE_URL
./run.sh                       # every example
./run.sh tests/search.spec.ts  # just one
```

`run.sh` installs the dependencies (including the published SDK, pinned in
`package.json`) and runs the suite with [Jest](https://jestjs.io/).

Requires Node.js ≥ 20.

## What each example shows

Every spec in `tests/` is listed here. They run independently — read one on its own, or
`./run.sh tests/<name>.spec.ts` to watch it work.

**Records**

| Example | Demonstrates |
|---|---|
| `records` | Full record lifecycle, the three search modes, lookup fields, version history. |
| `records-batch` | `POST /v1/records/batch` — both commit modes, and the difference: `best_effort` commits each item independently, `all_or_nothing` writes nothing if any item fails. |
| `records-archive` | The record `ARCHIVED` lifecycle — a soft retraction from search and RAG that keeps the record retrievable by id. |
| `records-update-consistency` | An update makes the new content searchable and the old content stops surfacing — no window where search shows stale or missing content. |
| `records-tiering-safety` | Payload tiering: once a payload is externalized, list and lookup return only the inline projection — and the guard that stops a `PUT` truncating what it did not read. |
| `records-ttl` | The write-time contract for an absolute record TTL (`expiresAt`): the opt-in gate, the minimum floor, rejection of a malformed value, and that setting or extending an expiry is never dropped as a no-op. The reap itself runs on DynamoDB's schedule, so no test observes the deletion. |
| `patch` | RFC-7386 merge-PATCH: partial update, optimistic-lock conflicts. |
| `type-fidelity` | A schema's declared field types survive the full round trip, and a partial update never trips a type error on a field it did not touch. |
| `composite-lookup` | A lookup declared over several fields at once (`fieldNames` + the `field=a,b` / `values` query form), including the partial-tuple grouping behavior, the `sortFrom`/`sortTo` sort-key window, and the array-typed `values` parameter's encoding. |

**Documents & folders**

| Example | Demonstrates |
|---|---|
| `documents-text` / `documents-upload` | Text ingest and the presigned-URL upload handshake. |
| `documents-ask` | Streaming single-document Q&A. |
| `documents-archive` | The document `ARCHIVED` lifecycle and the de-index contract, including re-asserting an archive on an item that had been written back into the index. |
| `documents-reupload` | Replacing a file on an existing document by `externalId`, without re-sending `indexMode`. |
| `documents-storetext` | The `storeText` retention choice, fixed at ingest: keep the extracted text, or discard it once indexing completes. |
| `documents-filterable-projection` | Which schema-bound payload fields become `?filters=` targets — a field is a filter target because it was declared `filterable`, not because it happens to be short. |
| `folders` | Folder hierarchy and protection rules. |
| `external-id-collision` | An `externalId` can no longer be moved onto a slot another document or entity already holds. |

**Search & inference**

| Example | Demonstrates |
|---|---|
| `search` | Cross-content hybrid search, pagination (`hasMore`, the full 1–100 `limit` range), unique-document dedup, `externalId` on hits, and `textScore` in `TEXT` mode. |
| `null-sentinel-search` | The null sentinel in a search scope clause: adding `null` to a `data_scope` value list additionally reaches owner-less (tenant-level) rows, without widening past what the caller could already read — proven on both the text and the vector engine. |
| `schema-reserved-fields` | The field ids a schema may not declare `filterable` — the platform's own search-index metadata keys — and where that check deliberately stops. |
| `chat` / `rag` | Streaming inference and grounded RAG over your corpus. |
| `models` | Model catalog, plan gating, per-region pricing. |

**Scripts & triggers**

| Example | Demonstrates |
|---|---|
| `scripts-execute` | `POST /v1/scripts/execute` — push a stored script, run it as one atomic transaction, and read back what it created. The reference example for composing several writes into one call. |
| `scripts-triggers` | Storing script versions (`/v1/scripts`), declaring the rules that run them (`/v1/triggers`), and the failure surface (`GET /v1/trigger-failures`). |
| `trigger-firing` | A declared rule actually fires: a record write on a triggers-enabled schema dispatches its script asynchronously under the rule's own grant. |
| `triggers-projection` | The declare-time half of a rule's field projection — which fields a rule may name in `fields`, and why. |
| `triggers-input-cap` | The 224 KB ceiling on a trigger's projected input, and the `INPUT_TOO_LARGE` failure that names the size and the limit. |

**Identity, access & auth**

| Example | Demonstrates |
|---|---|
| `auth` | Health check + scoped-token mint and enforcement, including the `data_scope` placement matchers (`${{ under.self.scope.<namespace> }}`, the `"*"` dimension wildcard). |
| `identity` | Users and namespaced identity entities (`org`/`client`); parent ownership via `scopes`; `externalId` idempotency. |
| `access-profiles` | Role and access-profile CRUD, the inline-`scopes`-vs-`roleId` XOR, and the `profiles:c/u/d` principal qualifier. |
| `capabilities` | `granted_capabilities` on a scope clause — named platform capabilities that reach across a partition boundary, which `allowed_actions` cannot express. |
| `scope-qualifier-axes` | The `[:<qualifier>]` segment of a scope entry through the real mint path: which resources correlate one, for which op letters. |
| `resolved-scope` | `resolvedScope` on the token endpoints — the plaintext scope returned alongside the token, so a client never decodes a JWT — plus `scopeFilters` on search. |
| `token-assume` | `POST /v1/auth/token/assume`: re-minting your own token with one or more identity namespace values switched. |
| `principal-lookup` | Cross-context principal lookup — the same principal's profiles across every app context it reaches. |
| `namespaces` | Namespace placement (tenant-wide vs context-owned, fixed at registration) and namespace membership. |
| `issuers-token-exchange` | The trusted BYO-IdP issuer registry and RFC 8693 token exchange. |
| `invite-validation` | The two validation rules around sub-user invitations, including the frozen email while an invitation is outstanding. |
| `status-validation` | `status` on the update paths — normalised and validated the way the create paths always were. |

**Contexts, operations & the contract**

| Example | Demonstrates |
|---|---|
| `app-contexts` | App-context CRUD, the confirm-gated destroy cascade that drains a context's data, and minting a root-key token targeted at a non-default context via `contextId`. |
| `cross-context-isolation` | An object in one app context is invisible to a sibling context, on every read path. |
| `schema-lineage` | `basedOn` schema customization (a shared base + owner-specific variants), `specificityRank` namespace tie-breaks, and the `userId`/`scope` selectors on schema and document-lookup resolution. |
| `residency` | Data-residency confinement (fail-closed). |
| `usage` | Usage counters after real operations. |
| `usage-reconcile` | Cross-tenant usage reconciliation: the totals across your live and test tenants agree. |
| `billing-exact` | Exact per-operation billing, pinned as before/after deltas rather than as directional assertions. |
| `logs` | `GET /v1/admin/logs` — the API call log, its filters, and the delegation chain on delegate-minted traffic. |
| `erasure-requests` | `POST`/`GET /v1/erasure-requests`: submit, poll to completion, and check the certificate's own claims. |
| `negative-paths` / `error-contract` | The error contract — asserting error *bodies*, not just status codes. |
| `cors-preflight` | The browser preflight contract: the headers a browser-hosted SDK caller needs permitted in order to read an API error at all. |
| `vectros-version-header` | The `Vectros-Version` request header — sent explicitly, echoed back on a supported version, and rejected with `400` on an unrecognized one. |

## Credentials

Most examples run with your live API key (`VECTROS_API_KEY`) and the base URL.
Two more drive specific examples and are skipped cleanly when unset:

- `VECTROS_TEST_API_KEY` — your test-environment key (every account has one), for
  the tenant-isolation examples.
- `VECTROS_LIVE_TENANT_ID` — your tenant id. Needed by every example that mints a
  scoped key against a specific context: `cross-context-isolation`, `app-contexts`,
  `access-profiles`, `capabilities`, `token-assume`, `erasure-requests`, `invite-validation`,
  `identity` and `logs`. Three of those skip cleanly without it — `cross-context-isolation`, `app-contexts` and
  `token-assume`; **the other six fail**, so set it before running the full suite.

## Cleanup

Each example creates resources in setup and deletes them in teardown. Cleanup
failures are logged but never mask a real test failure.
