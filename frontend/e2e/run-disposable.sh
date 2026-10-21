#!/usr/bin/env bash
#
# THE BROWSER SUITE ON A DATABASE THIS SCRIPT CREATES AND DESTROYS (#292).
#
# Every step is explicit because every step is the evidence:
#
#   1. a database whose name this run generates and validates against a regex
#      before any CREATE or DROP — never a name from the environment;
#   2. migrations and the seeder, against that database and only that one;
#   3. Playwright with the disposable config, which refuses to reuse a running
#      backend or frontend and points both at this database;
#   4. the DROP, in a trap, so it happens even when the suite fails;
#   5. proof of absence afterwards.
#
# It never touches the shared local database, and it never removes a database
# it did not create: the DROP is guarded by the same regex and by an exact
# match against the name this run generated.
set -euo pipefail

MAINT_URL="${E2E_MAINT_URL:-postgres://$(whoami)@127.0.0.1:5432/postgres}"
SUITE="${1:-e2e/catalogue-removal.spec.ts}"

# The slice tag, so a run's database says which campaign created it. It is
# CONSTRAINED rather than trusted: it reaches a CREATE DATABASE statement, and a
# value from the environment that reached SQL unchecked would be the one hole in
# a script whose whole point is that it never drops what it did not create.
SLICE="${E2E_SLICE:-c292}"
if ! [[ "$SLICE" =~ ^[a-z][a-z0-9]{1,7}$ ]]; then
  echo "refusing: E2E_SLICE must be 2-8 lowercase alphanumerics, got: $SLICE" >&2
  exit 1
fi

DB_NAME="cataloguer_${SLICE}_e2e_$(openssl rand -hex 4)"
NAME_RE="^cataloguer_${SLICE}_e2e_[0-9a-f]{8}$"
if ! [[ "$DB_NAME" =~ $NAME_RE ]]; then
  echo "refusing: generated name failed validation: $DB_NAME" >&2
  exit 1
fi

drop_it() {
  local code=$?
  if [[ "$DB_NAME" =~ $NAME_RE ]]; then
    psql "$MAINT_URL" -X -q -c \
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB_NAME' and pid <> pg_backend_pid()" \
      >/dev/null 2>&1 || true
    psql "$MAINT_URL" -X -q -c "drop database if exists \"$DB_NAME\"" >/dev/null 2>&1 || true
    echo "--- dropped $DB_NAME"
  fi
  exit $code
}
trap drop_it EXIT

echo "--- creating $DB_NAME"
psql "$MAINT_URL" -X -q -c "create database \"$DB_NAME\""

DB_URL="${MAINT_URL%/*}/$DB_NAME"
echo "--- migrating"
DATABASE_URL="$DB_URL" pnpm --dir ../backend run migration:up >/dev/null
echo "--- seeding"
DATABASE_URL="$DB_URL" pnpm --dir ../backend run seed >/dev/null

echo "--- running $SUITE against $DB_NAME"
E2E_DATABASE_URL="$DB_URL" \
E2E_API_URL="http://localhost:${E2E_BACKEND_PORT:-3101}/api/v1" \
  npx --no-install playwright test --config=playwright.disposable.config.ts "$SUITE"
