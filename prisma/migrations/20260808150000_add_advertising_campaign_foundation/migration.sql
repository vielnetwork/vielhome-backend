-- Monetization & Advertising -- Phase 3 (Backend/Domain Foundation).
-- Additive only: adds 2 new PermissionKey enum values, 3 new enums, and 1
-- new table (with its indexes and FK to buildings). Alters nothing
-- existing, drops nothing.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'ADVERTISING_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'ADVERTISING_MANAGE';

-- CreateEnum
CREATE TYPE "AdCampaignSource" AS ENUM ('DIRECT', 'MARKETPLACE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "AdPlacement" AS ENUM ('HOME_SERVICES_CAROUSEL', 'HOME_TODAY_OFFERS', 'HOME_CONTENT_CAROUSEL', 'HOME_FEATURED_LARGE');

-- CreateTable
CREATE TABLE "ad_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "AdCampaignSource" NOT NULL,
    "placement" "AdPlacement" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "targetCountry" TEXT,
    "targetCity" TEXT,
    "buildingId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_campaigns_placement_status_priority_idx" ON "ad_campaigns"("placement", "status", "priority");

-- CreateIndex
CREATE INDEX "ad_campaigns_status_startsAt_endsAt_idx" ON "ad_campaigns"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "ad_campaigns_buildingId_idx" ON "ad_campaigns"("buildingId");

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
