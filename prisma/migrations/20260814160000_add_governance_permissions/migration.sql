-- Governance Staff Admin Backend Enablement -- additive only: adds 2 new
-- PermissionKey enum values. Alters nothing existing, drops nothing, adds
-- no new table.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'GOVERNANCE_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'GOVERNANCE_MANAGE';
