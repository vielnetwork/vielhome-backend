-- ADR-097 -- Marketplace Review Workflow (Phase 2).
--
-- Revised after review: does NOT rename PENDING -> PENDING_REVIEW (no
-- functional need, would be a wire-breaking change for no gain) and does
-- NOT add a DRAFT value (no client creates draft listings, so it would
-- be unreachable dead surface area). Only ARCHIVED is new.
-- AlterEnum
ALTER TYPE "ServiceProviderStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
-- New submittedAt column, ADR-097 requirement 2. Existing rows are
-- backfilled from createdAt (every pre-existing row was created already
-- PENDING, same as every row created after this migration -- there is no
-- draft phase during which submittedAt could differ from createdAt at
-- creation time). Added nullable first, backfilled, then locked NOT NULL
-- with a going-forward default so future creates never need to set it
-- explicitly (same convention createdAt itself already uses).
ALTER TABLE "service_providers" ADD COLUMN     "submittedAt" TIMESTAMP(3);

UPDATE "service_providers" SET "submittedAt" = "createdAt";

ALTER TABLE "service_providers" ALTER COLUMN "submittedAt" SET NOT NULL;
ALTER TABLE "service_providers" ALTER COLUMN "submittedAt" SET DEFAULT CURRENT_TIMESTAMP;
