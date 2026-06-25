# Vectros examples

Runnable, end-to-end examples for the [Vectros](https://vectros.ai) API — in
**TypeScript, Python, and Java**, plus the **CLI** and the **MCP server**. Each
one talks to the real API and demonstrates a complete workflow: structured
records, document ingestion, hybrid search, grounded RAG, identity and access,
and inference.

These are complete, runnable workflows — not isolated snippets — that you run
against your own account with your own API key.

## Quickstart

You need a Vectros API key — create one in your dashboard. Then:

```bash
cp .env.example .env
# edit .env: set VECTROS_API_KEY and VECTROS_API_BASE_URL

cd typescript && ./run.sh      # or: python, java, mcp
```

Most examples run with your live API key. A couple (tenant isolation,
cross-context isolation) use your test key or tenant id and **skip themselves
automatically** when those aren't set — see `.env.example`.

## What's here

| Directory | Uses | Run |
|---|---|---|
| [`typescript/`](typescript/) | `@vectros-ai/sdk` (npm) | `./run.sh` |
| [`python/`](python/) | `vectros` (PyPI) | `./run.sh` |
| [`java/`](java/) | `ai.vectros:vectros-sdk` (Maven Central) | `./run.sh` |
| [`cli/`](cli/) | `@vectros-ai/cli` | `vectros login`, then `./demo.sh` |
| [`mcp/`](mcp/) | `@vectros-ai/mcp-server` | `./run.sh` |

Each directory has its own README with the details.

## Documentation

Full guides and the API reference: **https://docs.vectros.ai**

## License

[Apache License 2.0](LICENSE).
