-- 21_ADRs > ADR-124 — Gamification Hardening Phase 2 (Scale + Operations).
--
-- Three independent, additive changes, none of them destructive:
--
-- 1. `XpReason` gains `ADMIN_CORRECTION` — a Backoffice staff correction
--    to a person's XP, distinct from every existing (gameplay-only)
--    reason. `ALTER TYPE ... ADD VALUE` is safe inside this migration's
--    own transaction because the new value is never referenced again in
--    this same file (Postgres forbids using a freshly-added enum value in
--    the same transaction that added it).
--
-- 2. `PermissionKey` gains `GAMIFICATION_CORRECTION_MANAGE` — the MANAGE
--    counterpart to the pre-existing `GAMIFICATION_ANALYTICS_VIEW`. The
--    actual `Permission` row (and its grant to the Technical Admin role)
--    is created by `prisma/seed/rbac.seed.ts`, same "enum value here,
--    seeded row there" split every prior permission addition in this
--    schema has used — this migration only makes the enum value exist.
--
-- 3. `person_achievements` becomes revocable. The old plain
--    `person_achievements_personId_definitionId_key` unique index is
--    dropped and replaced by a partial unique index scoped to
--    `WHERE "revokedAt" IS NULL` — identical technique, identical
--    reasoning, to `staff_roles_staffId_roleId_active_key`/
--    `role_permissions_roleId_permissionId_active_key`
--    (20260730102614_add_rbac_foundation): "at most one ACTIVE row per
--    key at a time" instead of "at most one row per key, ever" — a
--    revoked-then-re-granted achievement gets a fresh row, and its full
--    history (original grant, revoke, any later re-grant) stays
--    queryable forever, never overwritten or deleted. No existing
--    `person_achievements` row has `revokedAt` set (the column is new),
--    so every pre-existing row is still "active" under the new index and
--    the invariant it enforces is byte-for-byte identical to the old
--    plain unique index for all data that exists today — this migration
--    cannot fail on pre-existing rows.

-- AlterEnum
ALTER TYPE "XpReason" ADD VALUE 'ADMIN_CORRECTION';

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'GAMIFICATION_CORRECTION_MANAGE';

-- DropIndex
DROP INDEX "person_achievements_personId_definitionId_key";

-- AlterTable
ALTER TABLE "person_achievements" ADD COLUMN "revokedById" TEXT,
                                   ADD COLUMN "revokedAt" TIMESTAMP(3);

-- CreateIndex (plain lookup index — the old unique index also served this
-- purpose incidentally; replaced explicitly since the new index below is
-- partial, not a general-purpose lookup index).
CREATE INDEX "person_achievements_personId_definitionId_idx" ON "person_achievements"("personId", "definitionId");

-- CreateIndex (the actual "at most one ACTIVE achievement per person per
-- definition" invariant — see this file's own header comment).
CREATE UNIQUE INDEX "person_achievements_personId_definitionId_active_key"
  ON "person_achievements"("personId", "definitionId")
  WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "person_achievements" ADD CONSTRAINT "person_achievements_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
