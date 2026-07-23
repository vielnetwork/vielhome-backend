-- AlterEnum
ALTER TYPE "VoteEligibilityType" ADD VALUE 'TENANT';
-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "pushToken" TEXT;
-- CreateTable
CREATE TABLE "building_settings" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "allowTenantVoting" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "building_settings_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "vote_proxies" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "granterPersonId" TEXT NOT NULL,
    "proxyPersonId" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "vote_proxies_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "building_settings_buildingId_key" ON "building_settings"("buildingId");
-- CreateIndex
CREATE INDEX "vote_proxies_unitId_isCurrent_idx" ON "vote_proxies"("unitId", "isCurrent");
-- CreateIndex
CREATE INDEX "vote_proxies_granterPersonId_isCurrent_idx" ON "vote_proxies"("granterPersonId", "isCurrent");
-- CreateIndex
CREATE UNIQUE INDEX "devices_pushToken_key" ON "devices"("pushToken");
-- AddForeignKey
ALTER TABLE "building_settings" ADD CONSTRAINT "building_settings_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "vote_proxies" ADD CONSTRAINT "vote_proxies_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "vote_proxies" ADD CONSTRAINT "vote_proxies_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "vote_proxies" ADD CONSTRAINT "vote_proxies_granterPersonId_fkey" FOREIGN KEY ("granterPersonId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "vote_proxies" ADD CONSTRAINT "vote_proxies_proxyPersonId_fkey" FOREIGN KEY ("proxyPersonId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
