-- FIN-EXP-02 -- Building Expense / Disbursement (see 21_ADRs > ADR-126).
-- Additive only: adds 1 new LedgerEntryType value, 1 new
-- DocumentReferenceEntityType value, 2 new enums (ExpenseCategory,
-- ExpenseStatus), and 1 new table (with its indexes and FKs to
-- buildings/funds/persons). Alters nothing existing, drops nothing.

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'EXPENSE';

-- AlterEnum
ALTER TYPE "DocumentReferenceEntityType" ADD VALUE 'EXPENSE';

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('UTILITIES', 'CLEANING', 'MAINTENANCE', 'REPAIR', 'ELEVATOR', 'SECURITY', 'INSURANCE', 'ADMINISTRATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('POSTED', 'VOIDED');

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "ExpenseCategory" NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'POSTED',
    "createdById" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expenses_idempotencyKey_key" ON "expenses"("idempotencyKey");

-- CreateIndex
CREATE INDEX "expenses_buildingId_idx" ON "expenses"("buildingId");

-- CreateIndex
CREATE INDEX "expenses_fundId_idx" ON "expenses"("fundId");

-- CreateIndex
CREATE INDEX "expenses_buildingId_status_idx" ON "expenses"("buildingId", "status");

-- CreateIndex
CREATE INDEX "expenses_buildingId_category_idx" ON "expenses"("buildingId", "category");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
