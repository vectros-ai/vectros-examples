#!/usr/bin/env bash
# Exercise the published Vectros MCP server against your own tenant.
#
#   cp ../.env.example ../.env   # then fill in VECTROS_API_KEY + VECTROS_API_BASE_URL
#   ./run.sh                     # run every example
#
# This launches the published @vectros-ai/mcp-server (via npx — no local build),
# speaks MCP over stdio, and exercises each tool against your tenant.
set -uo pipefail
cd "$(dirname "$0")"

for envfile in ./.env ../.env; do
  if [ -f "$envfile" ]; then set -a; . "$envfile"; set +a; break; fi
done

: "${VECTROS_API_KEY:?Set VECTROS_API_KEY — copy .env.example to .env and fill it in}"
: "${VECTROS_API_BASE_URL:?Set VECTROS_API_BASE_URL (e.g. https://api.vectros.ai)}"

# Run the published server (override with a specific version if you like).
export VECTROS_MCP_SMOKE_PACKAGE="${VECTROS_MCP_SMOKE_PACKAGE:-@vectros-ai/mcp-server@latest}"

npm install --silent
npm test
