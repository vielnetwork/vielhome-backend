-- AlterTable
ALTER TABLE "persons" ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT;

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "ownerFirstName" TEXT,
ADD COLUMN     "ownerLastName" TEXT;

-- Backfill known seeded/test accounts only.
UPDATE "persons"
SET "firstName" = 'Dev',
    "lastName" = 'Tester'
WHERE "phone" = '+989120000000'
  AND "firstName" IS NULL
  AND "lastName" IS NULL;

UPDATE "persons"
SET "firstName" = 'BackOffice',
    "lastName" = 'Reviewer'
WHERE "phone" = '+989120000001'
  AND "firstName" IS NULL
  AND "lastName" IS NULL;
