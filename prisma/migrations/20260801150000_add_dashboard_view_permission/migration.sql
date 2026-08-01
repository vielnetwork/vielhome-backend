-- ADR-110 (Backoffice Operational Dashboard) -- additive only: adds one
-- new enum value (DASHBOARD_VIEW), alters nothing existing, drops
-- nothing.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'DASHBOARD_VIEW';
