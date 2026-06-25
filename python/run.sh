#!/usr/bin/env bash
# Run the Vectros Python examples against your own tenant.
#
#   cp ../.env.example ../.env       # then fill in VECTROS_API_KEY + VECTROS_API_BASE_URL
#   ./run.sh                         # run every example
#   ./run.sh tests/test_chat.py      # run one example
#
set -uo pipefail
cd "$(dirname "$0")"

for envfile in ./.env ../.env; do
  if [ -f "$envfile" ]; then set -a; . "$envfile"; set +a; break; fi
done

: "${VECTROS_API_KEY:?Set VECTROS_API_KEY — copy .env.example to .env and fill it in}"
: "${VECTROS_API_BASE_URL:?Set VECTROS_API_BASE_URL (e.g. https://api.vectros.ai)}"

# Isolated virtualenv with the published `vectros` SDK + pytest.
PYBIN="$(command -v python3 || command -v python)"
[ -n "$PYBIN" ] || { echo "Python 3 is required (python3 not found on PATH)." >&2; exit 2; }
"$PYBIN" -m venv .venv
# shellcheck disable=SC1091
source .venv/Scripts/activate 2>/dev/null || source .venv/bin/activate
pip install --quiet -r requirements.txt

python -m pytest -q "$@"
