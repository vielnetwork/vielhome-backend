CREATE TYPE "AdSlotFillStrategy" AS ENUM ('DIRECT_ONLY', 'EXTERNAL_ONLY', 'DIRECT_THEN_EXTERNAL');
CREATE TYPE "AdExternalProvider" AS ENUM ('NONE', 'ADMOB');

ALTER TABLE "ad_slots"
ADD COLUMN "fillStrategy" "AdSlotFillStrategy" NOT NULL DEFAULT 'DIRECT_ONLY',
ADD COLUMN "externalProvider" "AdExternalProvider" NOT NULL DEFAULT 'NONE',
ADD COLUMN "androidAdUnitId" TEXT,
ADD COLUMN "iosAdUnitId" TEXT;

UPDATE "ad_slots"
SET
  "fillStrategy" = 'DIRECT_THEN_EXTERNAL',
  "externalProvider" = 'ADMOB',
  "androidAdUnitId" = 'ca-app-pub-3940256099942544/2247696110',
  "iosAdUnitId" = 'ca-app-pub-3940256099942544/3986624511'
WHERE "code" = 'HOM-N-06';
