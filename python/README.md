# Vectros Python examples

End-to-end examples for the Vectros API using the official Python SDK,
[`vectros`](https://pypi.org/project/vectros/). They drive the published SDK
against the live API and demonstrate the core request/response patterns.

## Run them

```bash
cp ../.env.example ../.env       # set VECTROS_API_KEY and VECTROS_API_BASE_URL
./run.sh                         # every example
./run.sh tests/test_chat.py      # just one
```

`run.sh` creates a virtualenv, installs the published SDK + [pytest](https://pytest.org/),
and runs the suite. Requires Python ≥ 3.8.

## What each example shows

| Example | Demonstrates |
|---|---|
| `test_auth` | Health check + scoped-token mint and enforcement. |
| `test_chat` | Streaming inference — the SSE event sequence. |
| `test_envelope` | The uniform `{ data, next_cursor }` list envelope and cursor paging. |
| `test_error_contract` | The error contract — asserting structured error bodies. |
| `test_cross_context` | App-context data isolation within a tenant. |
| `test_composite_lookup` | The composite lookup: `field_names` in place of `field_name`, and the array-typed `values` parameter. |
| `test_access_profiles` | The `profiles:c/u/d` principal-qualifier axis — a literal `usr_<id>`, or the `self` sentinel. |
| `test_capabilities` | `granted_capabilities` on a scope clause: named platform capabilities that reach across a partition boundary, which `allowed_actions` cannot express. |
| `test_namespaces` | Namespace placement (tenant-wide vs context-owned, fixed at registration) and namespace membership. |
| `test_issuers_token_exchange` | The trusted BYO-IdP issuer registry and RFC 8693 token exchange. |
| `test_logs` | `delegationChain` on `GET /v1/admin/logs` entries — present on delegate-minted traffic, null on ordinary traffic. |

`test_cross_context` needs `VECTROS_LIVE_TENANT_ID` and skips itself when it's unset (see
`../.env.example`). `test_capabilities` and `test_logs` need it too and **fail** rather than
skip without it — set it before running the full suite. The rest run with just your API key.
