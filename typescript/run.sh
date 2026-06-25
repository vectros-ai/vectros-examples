#!/usr/bin/env bash
# Run the Vectros TypeScript examples against your own tenant.
#
#   cp ../.env.example ../.env     # then fill in VECTROS_API_KEY + VECTROS_API_BASE_URL
#   ./run.sh                       # run every example
#   ./run.sh tests/search.spec.ts  # run one example
#
set -uo pipefail
cd "$(dirname "$0")"

# Load .env from this directory or the repository root, if present.
for envfile in ./.env ../.env; do
  if [ -f "$envfile" ]; then set -a; . "$envfile"; set +a; break; fi
done

: "${VECTROS_API_KEY:?Set VECTROS_API_KEY — copy .env.example to .env and fill it in}"
: "${VECTROS_API_BASE_URL:?Set VECTROS_API_BASE_URL (e.g. https://api.vectros.ai)}"

# Installs the test runner + the published @vectros-ai/sdk (pinned in package.json).
npm install --silent

npx jest --runInBand "$@"
