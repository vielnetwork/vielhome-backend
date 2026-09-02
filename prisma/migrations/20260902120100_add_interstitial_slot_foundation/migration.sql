CREATE TYPE "AdPresentationFormat" AS ENUM ('INLINE', 'FULL_SCREEN');

ALTER TABLE "ad_slots"
  ADD COLUMN "placement" "AdPlacement",
  ADD COLUMN "presentationFormat" "AdPresentationFormat" NOT NULL DEFAULT 'INLINE',
  ADD COLUMN "minimumDisplaySeconds" INTEGER,
  ADD COLUMN "skippable" BOOLEAN,
  ADD COLUMN "maxPerSession" INTEGER;

UPDATE "ad_slots"
SET "placement" = CASE
  WHEN "page" = 'HOME' AND "zone" = 'N' THEN 'HOME_TODAY_OFFERS'::"AdPlacement"
  WHEN "page" = 'HOME' AND "zone" = 'S' THEN 'HOME_FEATURED_LARGE'::"AdPlacement"
END;

ALTER TABLE "ad_slots" ALTER COLUMN "placement" SET NOT NULL;

ALTER TABLE "ad_slots"
  ADD CONSTRAINT "ad_slots_minimum_display_seconds_check"
    CHECK ("minimumDisplaySeconds" IS NULL OR "minimumDisplaySeconds" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ad_slots_max_per_session_check"
    CHECK ("maxPerSession" IS NULL OR "maxPerSession" >= 1),
  ADD CONSTRAINT "ad_slots_full_screen_policy_check"
    CHECK (
      "presentationFormat" = 'INLINE'
      OR (
        "minimumDisplaySeconds" IS NOT NULL
        AND "skippable" IS NOT NULL
        AND "maxPerSession" IS NOT NULL
        AND "fillStrategy" = 'DIRECT_ONLY'
        AND "externalProvider" = 'NONE'
        AND "androidAdUnitId" IS NULL
        AND "iosAdUnitId" IS NULL
      )
    ),
  ADD CONSTRAINT "ad_slots_interstitial_presentation_check"
    CHECK (
      ("placement" IN ('HOME_INTERSTITIAL', 'PAYMENT_ENTRY_INTERSTITIAL') AND "presentationFormat" = 'FULL_SCREEN')
      OR
      ("placement" NOT IN ('HOME_INTERSTITIAL', 'PAYMENT_ENTRY_INTERSTITIAL') AND "presentationFormat" = 'INLINE')
    );

CREATE INDEX "ad_slots_placement_isActive_position_idx"
  ON "ad_slots"("placement", "isActive", "position");

INSERT INTO "ad_slots" (
  "id", "code", "page", "zone", "position", "label", "description", "orientation",
  "placement", "presentationFormat", "minimumDisplaySeconds", "skippable", "maxPerSession",
  "fillStrategy", "externalProvider", "androidAdUnitId", "iosAdUnitId", "isActive", "createdAt", "updatedAt"
) VALUES
  ('slot-home-i-01', 'HOM-I-01', 'HOME', 'I', 1, 'Home — Interstitial — Slot 1',
   'Direct full-screen interstitial shown from Home.', 'VERTICAL', 'HOME_INTERSTITIAL',
   'FULL_SCREEN', 3, TRUE, 1, 'DIRECT_ONLY', 'NONE', NULL, NULL, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('slot-payment-i-01', 'PAY-I-01', 'PAYMENT', 'I', 1, 'Payment Entry — Interstitial — Slot 1',
   'Direct full-screen interstitial shown before payment entry.', 'VERTICAL', 'PAYMENT_ENTRY_INTERSTITIAL',
   'FULL_SCREEN', 3, TRUE, 1, 'DIRECT_ONLY', 'NONE', NULL, NULL, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
