CREATE TYPE "ServiceContractInvoiceStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID');
CREATE TYPE "ServiceContractPaymentStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

CREATE TABLE "service_contract_invoices" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "buildingId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "paidAmount" INTEGER NOT NULL DEFAULT 0,
  "dueDate" TIMESTAMP(3),
  "status" "ServiceContractInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_contract_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_contract_payments" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "buildingId" TEXT NOT NULL,
  "fundId" TEXT NOT NULL,
  "payerId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "status" "ServiceContractPaymentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "idempotencyKey" TEXT,
  "reference" TEXT,
  "note" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "rejectedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_contract_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_contract_invoices_buildingId_status_idx" ON "service_contract_invoices"("buildingId", "status");
CREATE INDEX "service_contract_invoices_contractId_idx" ON "service_contract_invoices"("contractId");
CREATE INDEX "service_contract_payments_buildingId_status_idx" ON "service_contract_payments"("buildingId", "status");
CREATE INDEX "service_contract_payments_invoiceId_idx" ON "service_contract_payments"("invoiceId");
CREATE UNIQUE INDEX "service_contract_payments_payerId_invoiceId_idempotencyKey_key" ON "service_contract_payments"("payerId", "invoiceId", "idempotencyKey");

ALTER TABLE "service_contract_invoices" ADD CONSTRAINT "service_contract_invoices_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "service_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contract_invoices" ADD CONSTRAINT "service_contract_invoices_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contract_payments" ADD CONSTRAINT "service_contract_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "service_contract_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contract_payments" ADD CONSTRAINT "service_contract_payments_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contract_payments" ADD CONSTRAINT "service_contract_payments_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contract_payments" ADD CONSTRAINT "service_contract_payments_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contract_payments" ADD CONSTRAINT "service_contract_payments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
