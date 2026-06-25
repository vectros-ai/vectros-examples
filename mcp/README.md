# Vectros MCP server examples

These examples exercise the official Vectros MCP server,
[`@vectros-ai/mcp-server`](https://www.npmjs.com/package/@vectros-ai/mcp-server),
which exposes the Vectros API as [Model Context Protocol](https://modelcontextprotocol.io/)
tools for agentic use. Each example launches the published server, speaks MCP
over stdio, and exercises a tool against your tenant.

## Run them

```bash
cp ../.env.example ../.env   # set VECTROS_API_KEY and VECTROS_API_BASE_URL
./run.sh                     # every example
```

`run.sh` runs the published server via `npx` (no local build) and drives it with
the MCP client. Requires Node.js ≥ 20.

## What the examples cover

The handshake and tool catalog; `hybrid_search`; `rag_ask` and `document_ask`
(streaming, with progress notifications); `document_ingest` (text and file) and
`document_query`; the record lifecycle (`record_create` → `record_get` →
`record_query` → `record_update` → `record_delete`); folder CRUD; `list_schemas`,
`lookup_principal`, `version_history`, and `current_identity`.

## Using the server with your own MCP client

Point any MCP client (e.g. Claude Desktop or Claude Code) at the published
server:

```json
{
  "mcpServers": {
    "vectros": {
      "command": "npx",
      "args": ["-y", "@vectros-ai/mcp-server"],
      "env": {
        "VECTROS_API_KEY": "sk_live_…",
        "VECTROS_API_BASE_URL": "https://api.vectros.ai"
      }
    }
  }
}
```

The Vectros CLI can write this configuration for you —
`vectros bootstrap --client code` (or `--client desktop`) merges a scoped
credential into your MCP client's config. See the `cli/` example.
