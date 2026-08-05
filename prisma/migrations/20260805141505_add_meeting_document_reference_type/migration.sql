-- Governance Hardening Phase 3 (audit §23) -- additive only: adds one
-- new enum value (MEETING) to DocumentReferenceEntityType, alters
-- nothing existing, drops nothing. Closes the asymmetry where a Vote
-- could be referenced by a Document but a Meeting could not. Same
-- unchecked-entityId pattern CASE/SERVICE_PROVIDER/SUPPORT_CASE already
-- use -- see CreateReferenceDto's own comment for why entityId existence
-- is deliberately not cross-checked against the target domain.

-- AlterEnum
ALTER TYPE "DocumentReferenceEntityType" ADD VALUE 'MEETING';
