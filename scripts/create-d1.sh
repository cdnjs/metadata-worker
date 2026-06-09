#!/usr/bin/env bash
# Provision a D1 database for shadow comparison and apply the schema.
#
# Run in two phases, because wrangler can't apply the schema --remote until
# the database_id is wired into the config:
#
#   Phase 1 — create:
#     ./scripts/create-d1.sh staging create
#     # Copy the printed database_id into worker-api-cdnjs-account-wrangler.toml
#     # under [[env.staging.d1_databases]].
#
#   Phase 2 — migrate (after pasting the id):
#     ./scripts/create-d1.sh staging migrate
#
# Same for production. Or run without an action to do the legacy
# create-then-migrate flow (only works if database_id is already filled in).

set -euo pipefail

ENV="${1:-}"
ACTION="${2:-all}"

if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "Usage: $0 <staging|production> [create|migrate|all]" >&2
  exit 1
fi
if [[ "$ACTION" != "create" && "$ACTION" != "migrate" && "$ACTION" != "all" ]]; then
  echo "Action must be one of: create, migrate, all" >&2
  exit 1
fi

WRANGLER_CONFIG="worker-api-cdnjs-account-wrangler.toml"
DB_NAME="cdnjs-shadow-mismatches-${ENV}"
SCHEMA="migrations/0001_shadow_mismatches.sql"

if [[ "$ACTION" == "create" || "$ACTION" == "all" ]]; then
  echo "==> Phase 1: creating D1 database '${DB_NAME}'"
  # No --env here: we deliberately do not bind to the env yet, because the
  # config still has database_id = "" and wrangler would refuse.
  npx wrangler d1 create "${DB_NAME}" --config "${WRANGLER_CONFIG}"
  echo
  echo "Now paste the database_id printed above into ${WRANGLER_CONFIG}:"
  echo
  echo "     [[env.${ENV}.d1_databases]]"
  echo "     binding = \"SHADOW_DB\""
  echo "     database_name = \"${DB_NAME}\""
  echo "     database_id = \"<paste-here>\""
  echo
  if [[ "$ACTION" == "create" ]]; then
    echo "Then run:  $0 ${ENV} migrate"
    exit 0
  fi
fi

if [[ "$ACTION" == "migrate" || "$ACTION" == "all" ]]; then
  echo "==> Phase 2: applying schema ${SCHEMA} to ${DB_NAME} (remote)"
  npx wrangler d1 execute "${DB_NAME}" \
    --config "${WRANGLER_CONFIG}" \
    --env "${ENV}" \
    --remote \
    --file "${SCHEMA}"
  echo
  echo "Done. To verify:"
  echo "  npx wrangler d1 execute ${DB_NAME} \\"
  echo "    --config ${WRANGLER_CONFIG} --env ${ENV} --remote \\"
  echo "    --command \"SELECT name FROM sqlite_master WHERE type='table'\""
fi
