-- CreateEnum
CREATE TYPE "DocumentUploadPurpose" AS ENUM ('CREATE_DOCUMENT', 'CREATE_VERSION');

-- CreateTable
CREATE TABLE "document_upload_intents" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "purpose" "DocumentUploadPurpose" NOT NULL,
    "documentId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "document_upload_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_upload_intents_storageKey_key" ON "document_upload_intents"("storageKey");

-- CreateIndex
CREATE INDEX "document_upload_intents_buildingId_consumedAt_expiresAt_idx" ON "document_upload_intents"("buildingId", "consumedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "document_upload_intents_requestedById_consumedAt_expiresAt_idx" ON "document_upload_intents"("requestedById", "consumedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "document_upload_intents_documentId_idx" ON "document_upload_intents"("documentId");

-- AddForeignKey
ALTER TABLE "document_upload_intents" ADD CONSTRAINT "document_upload_intents_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_upload_intents" ADD CONSTRAINT "document_upload_intents_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_upload_intents" ADD CONSTRAINT "document_upload_intents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
