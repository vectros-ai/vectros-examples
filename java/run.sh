#!/usr/bin/env bash
# Run the Vectros Java examples against your own tenant.
#
#   cp ../.env.example ../.env   # then fill in VECTROS_API_KEY + VECTROS_API_BASE_URL
#   ./run.sh                     # run every example
#
# Requires a JDK 21+ on JAVA_HOME. The Maven wrapper (./mvnw) is vendored, so no
# global Maven install is needed; the Vectros SDK resolves from Maven Central.
set -uo pipefail
cd "$(dirname "$0")"

for envfile in ./.env ../.env; do
  if [ -f "$envfile" ]; then set -a; . "$envfile"; set +a; break; fi
done

: "${VECTROS_API_KEY:?Set VECTROS_API_KEY — copy .env.example to .env and fill it in}"
: "${VECTROS_API_BASE_URL:?Set VECTROS_API_BASE_URL (e.g. https://api.vectros.ai)}"
[ -n "${JAVA_HOME:-}" ] || { echo "Set JAVA_HOME to a JDK 21+." >&2; exit 2; }

./mvnw -B --no-transfer-progress test "$@"
