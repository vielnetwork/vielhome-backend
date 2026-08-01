-- ADR-116 (Global Provider Settings) -- additive only: adds 2 new
-- PermissionKey enum values, 1 new enum, and 1 new table. Alters nothing
-- existing, drops nothing.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'PROVIDER_SETTINGS_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'PROVIDER_SETTINGS_MANAGE';

-- CreateEnum
CREATE TYPE "ProviderKey" AS ENUM ('EMAIL', 'SMS', 'PUSH');

-- CreateTable
CREATE TABLE "provider_settings" (
    "id" TEXT NOT NULL,
    "key" "ProviderKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "provider_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_settings_key_key" ON "provider_settings"("key");

-- AddForeignKey
ALTER TABLE "provider_settings" ADD CONSTRAINT "provider_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
