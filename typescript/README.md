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

| Example | Demonstrates |
|---|---|
| `auth` | Health check + scoped-token mint and enforcement, including the `data_scope` placement matchers (`${{ under.self.scope.<namespace> }}`, the `"*"` dimension wildcard). |
| `records` | Full record lifecycle, the three search modes, lookup fields, version history. |
| `composite-lookup` | A lookup declared over several fields at once (`fieldNames` + the `field=a,b` / `values` query form), including the partial-tuple grouping behavior, the `sortFrom`/`sortTo` sort-key window, and the array-typed `values` parameter's encoding. |
| `records-update-consistency` | An update makes the new content searchable and the old content stops surfacing — no window where search shows stale or missing content. |
| `vectros-version-header` | The `Vectros-Version` request header — sent explicitly, echoed back on a supported version, and rejected with `400` on an unrecognized one. |
| `documents-text` / `documents-upload` | Text ingest and the presigned-URL upload handshake. |
| `documents-ask` | Streaming single-document Q&A. |
| `folders` | Folder hierarchy and protection rules. |
| `identity` | Users and namespaced identity entities (`org`/`client`); parent ownership via `scopes`; `externalId` idempotency. |
| `search` | Cross-content hybrid search, pagination (`hasMore`, the full 1–100 `limit` range), unique-document dedup, `externalId` on hits, and `textScore` in `TEXT` mode. |
| `chat` / `rag` | Streaming inference and grounded RAG over your corpus. |
| `usage` | Usage counters after real operations. |
| `models` | Model catalog, plan gating, per-region pricing. |
| `patch` | RFC-7386 merge-PATCH: partial update, optimistic-lock conflicts. |
| `residency` | Data-residency confinement (fail-closed). |
| `negative-paths` / `error-contract` | The error contract — asserting error *bodies*, not just status codes. |
| `app-contexts` | App-context CRUD, the confirm-gated destroy cascade that drains a context's data, and minting a root-key token targeted at a non-default context via `contextId`. |
| `cross-context-isolation` | An object in one app context is invisible to a sibling context, on every read path. |
| `schema-lineage` | `basedOn` schema customization (a shared base + owner-specific variants), `specificityRank` namespace tie-breaks, and the `userId`/`scope` selectors on schema and document-lookup resolution. |

## Credentials

Most examples run with your live API key (`VECTROS_API_KEY`) and the base URL.
Two more drive specific examples and are skipped cleanly when unset:

- `VECTROS_TEST_API_KEY` — your test-environment key (every account has one), for
  the tenant-isolation examples.
- `VECTROS_LIVE_TENANT_ID` — your tenant id, for the cross-context isolation example.

## Cleanup

Each example creates resources in setup and deletes them in teardown. Cleanup
failures are logged but never mask a real test failure.
