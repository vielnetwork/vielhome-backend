CREATE TYPE "AdSlotOrientation" AS ENUM ('HORIZONTAL', 'VERTICAL');

CREATE TABLE "ad_slots" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "orientation" "AdSlotOrientation" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ad_slots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ad_slots_code_key" ON "ad_slots"("code");
CREATE UNIQUE INDEX "ad_slots_page_zone_position_key" ON "ad_slots"("page", "zone", "position");
CREATE INDEX "ad_slots_page_zone_isActive_position_idx" ON "ad_slots"("page", "zone", "isActive", "position");

ALTER TABLE "ad_campaigns" ADD COLUMN "adSlotId" TEXT;
CREATE INDEX "ad_campaigns_adSlotId_status_startsAt_endsAt_idx" ON "ad_campaigns"("adSlotId", "status", "startsAt", "endsAt");
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_adSlotId_fkey" FOREIGN KEY ("adSlotId") REFERENCES "ad_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "ad_slots" ("id", "code", "page", "zone", "position", "label", "description", "orientation", "updatedAt") VALUES
  ('slot-home-n-01', 'HOM-N-01', 'HOME', 'N', 1, 'Home — Top Carousel — Slot 1', 'Position 1 in the Home top horizontal carousel.', 'HORIZONTAL', CURRENT_TIMESTAMP),
  ('slot-home-n-02', 'HOM-N-02', 'HOME', 'N', 2, 'Home — Top Carousel — Slot 2', 'Position 2 in the Home top horizontal carousel.', 'HORIZONTAL', CURRENT_TIMESTAMP),
  ('slot-home-n-03', 'HOM-N-03', 'HOME', 'N', 3, 'Home — Top Carousel — Slot 3', 'Position 3 in the Home top horizontal carousel.', 'HORIZONTAL', CURRENT_TIMESTAMP),
  ('slot-home-n-04', 'HOM-N-04', 'HOME', 'N', 4, 'Home — Top Carousel — Slot 4', 'Position 4 in the Home top horizontal carousel.', 'HORIZONTAL', CURRENT_TIMESTAMP),
  ('slot-home-n-05', 'HOM-N-05', 'HOME', 'N', 5, 'Home — Top Carousel — Slot 5', 'Position 5 in the Home top horizontal carousel.', 'HORIZONTAL', CURRENT_TIMESTAMP),
  ('slot-home-n-06', 'HOM-N-06', 'HOME', 'N', 6, 'Home — Top Carousel — Slot 6', 'Position 6 in the Home top horizontal carousel.', 'HORIZONTAL', CURRENT_TIMESTAMP),
  ('slot-home-s-01', 'HOM-S-01', 'HOME', 'S', 1, 'Home — Lower Ads — Slot 1', 'Position 1 in the Home lower vertical advertising area.', 'VERTICAL', CURRENT_TIMESTAMP),
  ('slot-home-s-02', 'HOM-S-02', 'HOME', 'S', 2, 'Home — Lower Ads — Slot 2', 'Position 2 in the Home lower vertical advertising area.', 'VERTICAL', CURRENT_TIMESTAMP),
  ('slot-home-s-03', 'HOM-S-03', 'HOME', 'S', 3, 'Home — Lower Ads — Slot 3', 'Position 3 in the Home lower vertical advertising area.', 'VERTICAL', CURRENT_TIMESTAMP);

UPDATE "ad_campaigns" SET "adSlotId" = 'slot-home-n-01' WHERE "adSlotId" IS NULL AND "placement" = 'HOME_TODAY_OFFERS';
UPDATE "ad_campaigns" SET "adSlotId" = 'slot-home-s-01' WHERE "adSlotId" IS NULL AND "placement" = 'HOME_FEATURED_LARGE';
