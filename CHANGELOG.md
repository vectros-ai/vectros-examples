# Changelog — Vectros examples

All notable changes to the Vectros examples are documented here. This project
adheres to [Semantic Versioning](https://semver.org). The version below is the
release version of this examples collection; each language example pins a
published Vectros SDK independently.

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
