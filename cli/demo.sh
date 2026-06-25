#!/usr/bin/env bash
# A short, read-only tour of the Vectros CLI.
#
# Prerequisites (one time):
#   npm install -g @vectros-ai/cli
#   vectros login          # interactive — opens your browser to sign in
#
# Then:
#   ./demo.sh
#
# Every command below only READS — it creates and changes nothing. See README.md
# for the full command surface (keys, contexts, blueprints, …).
set -uo pipefail

if ! command -v vectros >/dev/null 2>&1; then
  echo "The 'vectros' CLI is not installed. Run: npm install -g @vectros-ai/cli" >&2
  exit 1
fi

echo "== Who am I? =="
vectros whoami

echo
echo "== API keys =="
vectros key list

echo
echo "== Application contexts =="
vectros context list
