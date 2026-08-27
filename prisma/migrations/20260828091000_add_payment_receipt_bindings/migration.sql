-- A receipt upload intent is durably bound to one existing Payment. Existing
-- document intents remain unbound to payments.
ALTER TABLE "document_upload_intents" ADD COLUMN "paymentId" TEXT;

-- Normalize historical intent purposes deterministically from the existing
-- document binding before enforcing the complete three-purpose invariant.
-- This never creates a PAYMENT_RECEIPT intent.
UPDATE "document_upload_intents"
SET "purpose" = CASE
  WHEN "documentId" IS NULL THEN 'CREATE_DOCUMENT'::"DocumentUploadPurpose"
  ELSE 'CREATE_VERSION'::"DocumentUploadPurpose"
END;

ALTER TABLE "document_upload_intents"
ADD CONSTRAINT "document_upload_intents_purpose_binding_check"
CHECK (
  ("purpose" = 'CREATE_DOCUMENT' AND "documentId" IS NULL AND "paymentId" IS NULL)
  OR
  ("purpose" = 'CREATE_VERSION' AND "documentId" IS NOT NULL AND "paymentId" IS NULL)
  OR
  ("purpose" = 'PAYMENT_RECEIPT' AND "documentId" IS NULL AND "paymentId" IS NOT NULL)
);

ALTER TABLE "document_upload_intents"
ADD CONSTRAINT "document_upload_intents_paymentId_fkey"
FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "document_upload_intents_paymentId_idx"
ON "document_upload_intents"("paymentId");

-- One PAYMENT reference is the MVP receipt binding for one payment. Other
-- reference entity types retain their existing many-reference behavior.
CREATE UNIQUE INDEX "document_references_payment_entityId_key"
ON "document_references"("entityId")
WHERE "entityType" = 'PAYMENT';
