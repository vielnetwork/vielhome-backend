/*
  Warnings:

  - A unique constraint covering the columns `[sourceType,sourceId]` on the table `adjustments` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ChargeUnitScope" AS ENUM ('ALL', 'RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ChargePayerType" AS ENUM ('OWNER', 'TENANT');

-- CreateEnum
CREATE TYPE "LateFeeType" AS ENUM ('FIXED', 'PERCENTAGE');

-- AlterTable
ALTER TABLE "adjustments" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- AlterTable
ALTER TABLE "charge_batches" ADD COLUMN     "lateFeeGraceDays" INTEGER,
ADD COLUMN     "lateFeeType" "LateFeeType",
ADD COLUMN     "lateFeeValue" INTEGER,
ADD COLUMN     "payerType" "ChargePayerType",
ADD COLUMN     "unitScope" "ChargeUnitScope";

-- AlterTable
ALTER TABLE "charge_items" ADD COLUMN     "resolvedPayerType" "ChargePayerType";

-- CreateTable
CREATE TABLE "charge_item_payers" (
    "id" TEXT NOT NULL,
    "chargeItemId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_item_payers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "charge_item_payers_chargeItemId_idx" ON "charge_item_payers"("chargeItemId");

-- CreateIndex
CREATE INDEX "charge_item_payers_personId_idx" ON "charge_item_payers"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "charge_item_payers_chargeItemId_personId_key" ON "charge_item_payers"("chargeItemId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "adjustments_sourceType_sourceId_key" ON "adjustments"("sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "charge_item_payers" ADD CONSTRAINT "charge_item_payers_chargeItemId_fkey" FOREIGN KEY ("chargeItemId") REFERENCES "charge_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_item_payers" ADD CONSTRAINT "charge_item_payers_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
