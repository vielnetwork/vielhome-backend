-- ADR-117 (Backoffice Analytics -- Stage 10) -- additive only: adds 1 new
-- PermissionKey enum value. Alters nothing existing, drops nothing, adds
-- no new table.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'ANALYTICS_VIEW';
