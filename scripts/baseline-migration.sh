#!/usr/bin/env bash
#
# ADR-063 — Generates the baseline Prisma migration for the already-existing
# v1.0 schema/database.
#
# WHY THIS EXISTS: ADR-062 (V1.0 API Contract + Database Schema Freeze)
# named "no prisma/migrations/ folder" as an explicit release blocker — this
# project has shipped as cumulative full-repo deliveries every sprint since
# ADR-022 (Sprint 3.9), and the sandbox that produced them has never had
# npm registry or live-database access, so no migration SQL was ever
# generated or committed anywhere. Confirmed via the user's own ADR-062
# verification run: their real dev database already matches the current
# `prisma/schema.prisma` exactly (`prisma migrate diff` reported no
# difference, `prisma db pull` introspected all 60 models cleanly), so this
# is a pure baselining problem, not a schema-drift problem — there is
# nothing to migrate, only a migration history to establish going forward.
#
# WHAT THIS SCRIPT DOES: follows Prisma's own documented "baselining an
# existing database" workflow exactly —
#   https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining
# 1. Generates the SQL that would build the current schema from scratch,
#    computed purely from prisma/schema.prisma (no live database needed for
#    this step — `--from-empty --to-schema-datamodel` is schema-to-schema).
# 2. Marks that migration as already-applied in your real database's
#    `_prisma_migrations` tracking table, WITHOUT executing the SQL against
#    your database — your data is untouched. This step DOES need your real
#    DATABASE_URL (from .env), since it writes one tracking row.
#
# After this, `prisma migrate dev`/`deploy` will treat this baseline as
# already-applied history and layer any future migration on top of it
# normally — this script is meant to run exactly ONCE, ever.
#
# Prerequisites: run this from the project root, with `npm install` already
# done and a working `.env` pointing at your real dev database (the same
# one you've been running `prisma migrate dev`/`db pull`/`validate` against
# for ADR-062's own verification).

set -euo pipefail

MIGRATION_NAME="0_baseline_v1_freeze"
MIGRATION_DIR="prisma/migrations/${MIGRATION_NAME}"

if [ -d "prisma/migrations" ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "prisma/migrations/ already has content — refusing to overwrite." >&2
  echo "If you intend to re-baseline, remove or rename the existing folder first." >&2
  exit 1
fi

echo "==> Generating baseline migration SQL (schema-to-schema, no database needed for this step)..."
mkdir -p "$MIGRATION_DIR"
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$MIGRATION_DIR/migration.sql"

if [ ! -s "$MIGRATION_DIR/migration.sql" ]; then
  echo "ERROR: generated migration.sql is empty — something went wrong. Aborting before touching the database." >&2
  exit 1
fi

echo "==> Generated $(wc -l < "$MIGRATION_DIR/migration.sql") lines of SQL at ${MIGRATION_DIR}/migration.sql"
echo ""
echo "==> Marking ${MIGRATION_NAME} as already applied in your real database's _prisma_migrations table..."
echo "    (this records a tracking row only — the SQL above is NOT executed against your data)"
npx prisma migrate resolve --applied "$MIGRATION_NAME"

echo ""
echo "==> Verifying..."
npx prisma migrate status

echo ""
echo "Done. Next steps:"
echo "  git add prisma/migrations"
echo "  git commit -m 'Add baseline Prisma migration (ADR-063)'"
echo ""
echo "From now on, any real schema change goes through the normal"
echo "'npx prisma migrate dev --name <change>' flow, which will create a"
echo "second, timestamped migration layered on top of this baseline."
