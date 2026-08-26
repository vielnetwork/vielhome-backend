-- Additive classification and selection-mode enums. Existing rows are not
-- reclassified or interpreted from historical free text.
CREATE TYPE "ChargeKind" AS ENUM ('MONTHLY', 'RESERVE', 'REPAIR', 'SPECIAL', 'OTHER');
CREATE TYPE "PaymentSelectionMode" AS ENUM ('LEGACY_AUTOMATIC', 'EXPLICIT_SELECTION');

-- Stable building-owned identity for recurring monthly charge runs.
CREATE TABLE "charge_series" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_series_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "charge_batches"
    ADD COLUMN "kind" "ChargeKind",
    ADD COLUMN "seriesId" TEXT;

-- Every historical/current amount-only payment remains explicitly legacy.
ALTER TABLE "payments"
    ADD COLUMN "selectionMode" "PaymentSelectionMode" NOT NULL DEFAULT 'LEGACY_AUTOMATIC',
    ADD COLUMN "idempotencyKey" TEXT;

-- Pending intent is deliberately separate from approved accounting
-- allocations. Target rows are RESTRICTed from deletion for auditability.
CREATE TABLE "payment_debt_selections" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "chargeItemId" TEXT,
    "adjustmentId" TEXT,
    "selectedAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_debt_selections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_debt_selections_exactly_one_target_check"
        CHECK (("chargeItemId" IS NOT NULL) <> ("adjustmentId" IS NOT NULL)),
    CONSTRAINT "payment_debt_selections_selected_amount_positive_check"
        CHECK ("selectedAmount" > 0)
);

-- A classified monthly batch must have a series and ordering period. A
-- non-monthly or unclassified batch cannot accidentally join a series.
ALTER TABLE "charge_batches"
    ADD CONSTRAINT "charge_batches_monthly_series_period_check"
    CHECK (
        ("kind" = 'MONTHLY' AND "seriesId" IS NOT NULL AND "periodStart" IS NOT NULL)
        OR
        ("kind" IS DISTINCT FROM 'MONTHLY' AND "seriesId" IS NULL)
    );

CREATE UNIQUE INDEX "charge_series_buildingId_name_key"
    ON "charge_series"("buildingId", "name");
CREATE INDEX "charge_series_buildingId_idx" ON "charge_series"("buildingId");
CREATE INDEX "charge_batches_seriesId_idx" ON "charge_batches"("seriesId");

-- PostgreSQL partial uniqueness leaves every historical/non-monthly row
-- untouched while preventing ambiguous periods inside a monthly series.
CREATE UNIQUE INDEX "charge_batches_monthly_series_period_key"
    ON "charge_batches"("seriesId", "periodStart")
    WHERE "kind" = 'MONTHLY';

CREATE UNIQUE INDEX "payments_payerId_buildingId_idempotencyKey_key"
    ON "payments"("payerId", "buildingId", "idempotencyKey");

CREATE UNIQUE INDEX "payment_debt_selections_paymentId_chargeItemId_key"
    ON "payment_debt_selections"("paymentId", "chargeItemId");
CREATE UNIQUE INDEX "payment_debt_selections_paymentId_adjustmentId_key"
    ON "payment_debt_selections"("paymentId", "adjustmentId");
CREATE INDEX "payment_debt_selections_paymentId_idx"
    ON "payment_debt_selections"("paymentId");
CREATE INDEX "payment_debt_selections_chargeItemId_idx"
    ON "payment_debt_selections"("chargeItemId");
CREATE INDEX "payment_debt_selections_adjustmentId_idx"
    ON "payment_debt_selections"("adjustmentId");

ALTER TABLE "charge_series"
    ADD CONSTRAINT "charge_series_buildingId_fkey"
    FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "charge_batches"
    ADD CONSTRAINT "charge_batches_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "charge_series"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_debt_selections"
    ADD CONSTRAINT "payment_debt_selections_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_debt_selections"
    ADD CONSTRAINT "payment_debt_selections_chargeItemId_fkey"
    FOREIGN KEY ("chargeItemId") REFERENCES "charge_items"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_debt_selections"
    ADD CONSTRAINT "payment_debt_selections_adjustmentId_fkey"
    FOREIGN KEY ("adjustmentId") REFERENCES "adjustments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
