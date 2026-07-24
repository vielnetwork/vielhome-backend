-- ADR-094 (Sprint 29, Fund Management) reconciliation migration.
--
-- These schema changes were applied to the live development database via
-- `prisma db push` before this repository had real Prisma migration
-- history (baseline `0_baseline_v1_freeze` + `20260723000000_catch_up_
-- adr088_adr089`). This file exists to make migration history match what
-- the database and `schema.prisma` already agree on — it is intended to
-- be recorded via `prisma migrate resolve --applied
-- 20260723235959_adr094_fund_reconciliation`, NOT executed against the
-- existing development database (the columns/enum already exist there).
-- A fresh database (e.g. CI, a new developer's machine) applying the full
-- migration history from scratch WILL run this SQL for real, which is
-- exactly why it must be correct, not just a marker.
--
-- Verified directly against the live `prisma/schema.prisma` Fund model
-- and LedgerEntryType enum before being written (see ADR-095 in
-- `21_ADRs_v2.0`, Post-Delivery Verification) rather than reconstructed
-- from memory.

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'OPENING_BALANCE';

-- CreateEnum
CREATE TYPE "FundAccountLinkType" AS ENUM ('BANK', 'CASH');

-- AlterTable
ALTER TABLE "funds" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "accountLinkType" "FundAccountLinkType",
ADD COLUMN     "accountReference" TEXT;
