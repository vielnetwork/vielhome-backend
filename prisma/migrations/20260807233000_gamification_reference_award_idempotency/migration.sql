-- 21_ADRs > ADR-123 — Gamification reference-award idempotency hardening.
--
-- Replaces the old plain (referenceType, referenceId) index on
-- xp_transactions with a UNIQUE composite index that also includes
-- `reason`. This is the durable, DB-level guarantee behind
-- GamificationRepository.awardXp's new reference-conflict handling: at
-- most one XpTransaction may ever exist per (referenceType, referenceId,
-- reason) triple.
--
-- Safety for existing data: PROFILE_CREATED / BUILDING_SETUP_COMPLETED /
-- VOTE_PARTICIPATED never populate referenceType/referenceId, and
-- Postgres treats every NULL as distinct from every other NULL in a
-- UNIQUE index, so this migration is a guaranteed no-op risk for those
-- rows regardless of how much existing data there is.
--
-- CHARGE_PAID / CHARGE_PAID_REVERSED already had an application-level
-- (read-before-write) duplicate guard, so real duplicate rows there are
-- considered unlikely but not proven impossible. CASE_RESOLVED is the one
-- reason this hardening pass's own audit confirmed WAS awarded more than
-- once per case, in any environment that exercised the Cases
-- resolve -> reopen -> resolve lifecycle before this migration.
--
-- This migration intentionally does NOT delete, merge, or rewrite any
-- existing XpTransaction row to force a clean apply — doing so would
-- violate this codebase's own append-only-ledger convention ("audit
-- trail, not a mutable counter") to satisfy a new invariant. If this
-- CREATE UNIQUE INDEX statement fails in a given environment because real
-- duplicate (referenceType, referenceId, reason) rows already exist,
-- that is the correct, intentional failure mode: it means a human
-- reconciliation decision (how to treat the historical over-awarded XP
-- and Building Score for the affected case/payment) is required before
-- this migration can be applied there, rather than this migration
-- silently discarding ledger history to make itself pass. See ADR-123 for
-- the full reasoning.

-- DropIndex
DROP INDEX "xp_transactions_referenceType_referenceId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "xp_transactions_referenceType_referenceId_reason_key" ON "xp_transactions"("referenceType", "referenceId", "reason");
