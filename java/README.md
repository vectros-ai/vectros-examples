# Vectros Java examples

End-to-end examples for the Vectros API using the official Java SDK,
[`ai.vectros:vectros-sdk`](https://central.sonatype.com/artifact/ai.vectros/vectros-sdk).
They drive the published SDK against the live API and demonstrate the core
request/response patterns.

## Run them

```bash
cp ../.env.example ../.env   # set VECTROS_API_KEY and VECTROS_API_BASE_URL
./run.sh                     # every example
```

`run.sh` uses the vendored Maven wrapper (`./mvnw`) — no global Maven install
needed — and resolves the SDK from Maven Central. Requires a JDK 21+ on
`JAVA_HOME`.

## What each example shows

| Example | Demonstrates |
|---|---|
| `AuthSmokeTest` | Health check + scoped-token mint and enforcement. |
| `ChatSmokeTest` | Streaming inference — the SSE event sequence. |
| `CompositeLookupSmokeTest` | A lookup declared over several fields at once (`fieldNames` + the array-typed `values` parameter), including a value containing a comma to prove it survives as one leg rather than being split. |
| `EnvelopeSmokeTest` | The uniform `{ data, nextCursor }` list envelope and cursor paging. |
| `ErrorContractSmokeTest` | The error contract — asserting structured error bodies. |
| `CrossContextSmokeTest` | App-context data isolation within a tenant. |
| `AccessProfilesSmokeTest` | The `profiles:c/u/d` principal-qualifier axis — a literal `usr_<id>`, or the `self` sentinel. |
| `CapabilitiesSmokeTest` | `granted_capabilities` on a scope clause: named platform capabilities that reach across a partition boundary, which `allowed_actions` cannot express. |
| `NamespacesSmokeTest` | Namespace placement (tenant-wide vs context-owned, fixed at registration) and namespace membership. |
| `IssuersTokenExchangeSmokeTest` | The trusted BYO-IdP issuer registry and RFC 8693 token exchange. |
| `LogsSmokeTest` | `delegationChain` on `GET /v1/admin/logs` entries — present on delegate-minted traffic, null on ordinary traffic. |

`CrossContextSmokeTest` needs `VECTROS_LIVE_TENANT_ID` and is skipped when it's unset (see
`../.env.example`). `CapabilitiesSmokeTest` and `LogsSmokeTest` need it too and **fail** rather
than skip without it — set it before running the full suite. The rest run with just your API key.

## Pinning a version

The SDK version is set in `pom.xml` (`<vectros.sdk.version>`). Bump it to use a
newer release.
