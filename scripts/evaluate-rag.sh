#!/usr/bin/env bash
# Evaluates retrieval against the seeded organization and writes a report to
# ./eval/results. Runs as the host user so the report is not root-owned.
set -euo pipefail

ORG_ID=$(docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-opspilot_owner}" -d "${POSTGRES_DB:-opspilot}" \
  -tAc "select id from organizations where slug = 'acme'" | tr -d '[:space:]')

if [ -z "$ORG_ID" ]; then
  echo "No seeded organization found. Run 'make seed' first." >&2
  exit 1
fi

docker compose exec -T --user "$(id -u)" ai-service \
  python -m opspilot_ai.eval --organization-id "$ORG_ID" "$@"
