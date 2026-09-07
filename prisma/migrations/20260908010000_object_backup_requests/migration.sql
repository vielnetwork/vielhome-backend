-- CreateEnum
CREATE TYPE "ObjectBackupState" AS ENUM ('PENDING', 'COPYING', 'VERIFIED', 'FAILED', 'SOURCE_MISSING', 'RETIRED');

-- CreateTable
CREATE TABLE "object_backup_requests" (
    "id" TEXT NOT NULL,
    "sourceBucket" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "expectedSize" BIGINT,
    "state" "ObjectBackupState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "failureCode" TEXT,
    "finalizedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "object_backup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_backup_generations" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "backupBucket" TEXT NOT NULL,
    "backupKey" TEXT NOT NULL,
    "manifestKey" TEXT NOT NULL,
    "sourceETag" TEXT,
    "sourceLastModified" TEXT,
    "observedSize" BIGINT,
    "sha256" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_backup_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "object_backup_requests_state_nextAttemptAt_leaseUntil_idx" ON "object_backup_requests"("state", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "object_backup_requests_sourceBucket_sourceKey_idx" ON "object_backup_requests"("sourceBucket", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "object_backup_requests_sourceBucket_referenceType_reference_key" ON "object_backup_requests"("sourceBucket", "referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "object_backup_generations_captureId_key" ON "object_backup_generations"("captureId");

-- CreateIndex
CREATE UNIQUE INDEX "object_backup_generations_backupKey_key" ON "object_backup_generations"("backupKey");

-- CreateIndex
CREATE UNIQUE INDEX "object_backup_generations_manifestKey_key" ON "object_backup_generations"("manifestKey");

-- CreateIndex
CREATE INDEX "object_backup_generations_requestId_verifiedAt_idx" ON "object_backup_generations"("requestId", "verifiedAt");

-- AddForeignKey
ALTER TABLE "object_backup_generations" ADD CONSTRAINT "object_backup_generations_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "object_backup_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
