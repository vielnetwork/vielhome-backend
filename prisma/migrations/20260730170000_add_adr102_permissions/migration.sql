-- ADR-102 (Backoffice Permission Migration Completion) -- amends the
-- PermissionKey vocabulary again (ADR-099 -> ADR-101 -> this). Additive
-- only: adds 17 new enum values, alters nothing existing, drops nothing.
--
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction, as
-- long as no other statement in the same transaction references the new
-- value -- this migration only adds values, so it is safe standalone.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'BUILDING_VERIFICATION_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'BUILDING_VERIFICATION_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'MANAGER_VERIFICATION_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'MANAGER_VERIFICATION_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'FRAUD_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'FRAUD_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'SUPPORT_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'SUPPORT_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'COMPLIANCE_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'COMPLIANCE_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'LEGAL_HOLD_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'PERSON_ACCESS_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'PERSON_ACCESS_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'NOTIFICATION_TEMPLATE_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'NOTIFICATION_TEMPLATE_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'SCHEDULER_TRIGGER';
ALTER TYPE "PermissionKey" ADD VALUE 'GAMIFICATION_ANALYTICS_VIEW';
