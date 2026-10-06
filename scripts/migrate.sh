#!/usr/bin/env bash
#
# Apply every migration in migrations/ to every per-user database.
#
# Database-per-user means migrations run once per person. Wrangler records what
# it has applied in a d1_migrations table inside each database, so re-running
# this is a no-op — and 0001_init.sql is written with IF NOT EXISTS / INSERT OR
# IGNORE so it is independently idempotent too.
#
#   bash scripts/migrate.sh              # local (miniflare state in .wrangler/)
#   bash scripts/migrate.sh --remote     # the real Cloudflare databases
#
set -euo pipefail

# Keep in sync with the d1_databases entries in wrangler.toml.
DATABASES=("fitness-user1" "fitness-user2")

TARGET="${1:---local}"
case "$TARGET" in
  --local | --remote) ;;
  *)
    echo "usage: $0 [--local|--remote]" >&2
    exit 64
    ;;
esac

cd "$(dirname "$0")/.."

if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  echo "wrangler is not installed. Run: npm install" >&2
  exit 69
fi

for database in "${DATABASES[@]}"; do
  echo "==> applying migrations to ${database} (${TARGET})"
  npx --no-install wrangler d1 migrations apply "$database" "$TARGET"
done

echo "==> done: ${#DATABASES[@]} database(s) up to date"
