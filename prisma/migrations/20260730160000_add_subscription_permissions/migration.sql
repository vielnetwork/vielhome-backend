-- ADR-101 (Subscription Management Permission Migration) -- amends the
-- ADR-099 PermissionKey vocabulary. Additive only: adds two new enum
-- values, alters no existing table/column/enum value, drops nothing.
--
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction, as
-- long as the new value isn't referenced by another statement in the
-- same transaction -- this migration only adds the values, so it's safe
-- to run standalone exactly like this file.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'SUBSCRIPTION_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'SUBSCRIPTION_MANAGE';
