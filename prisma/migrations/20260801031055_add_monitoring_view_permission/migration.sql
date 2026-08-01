-- ADR-108 (Backoffice Monitoring & System Health) -- additive only: adds
-- one new enum value (MONITORING_VIEW), alters nothing existing, drops
-- nothing.
-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'MONITORING_VIEW';
