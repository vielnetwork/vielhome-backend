-- ADR-109 (Maintenance Mode & Feature Flags) -- additive only: adds 4 new
-- PermissionKey enum values and 2 new tables. Alters nothing existing,
-- drops nothing.

-- AlterEnum
ALTER TYPE "PermissionKey" ADD VALUE 'MAINTENANCE_MODE_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'MAINTENANCE_MODE_MANAGE';
ALTER TYPE "PermissionKey" ADD VALUE 'FEATURE_FLAGS_VIEW';
ALTER TYPE "PermissionKey" ADD VALUE 'FEATURE_FLAGS_MANAGE';

-- CreateTable
CREATE TABLE "maintenance_mode_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "message" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "maintenance_mode_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- AddForeignKey
ALTER TABLE "maintenance_mode_state" ADD CONSTRAINT "maintenance_mode_state_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
