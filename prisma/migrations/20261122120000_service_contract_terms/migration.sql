ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT_RECEIPT';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT_RETURN';
ALTER TYPE "ServiceContractInvoiceStatus" ADD VALUE 'CANCELLED';
ALTER TABLE "service_contracts"
  ADD COLUMN "durationMonths" INTEGER,
  ADD COLUMN "paymentIntervalMonths" INTEGER,
  ADD COLUMN "monthlyAmount" INTEGER,
  ADD COLUMN "depositAmount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "depositReceivedAt" TIMESTAMP(3),
  ADD COLUMN "depositRefundedAt" TIMESTAMP(3),
  ADD COLUMN "depositFundId" TEXT REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "service_contracts_customerPersonId_status_idx" ON "service_contracts"("customerPersonId", "status");
