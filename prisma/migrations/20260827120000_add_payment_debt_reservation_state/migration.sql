-- Explicit reservation lifecycle is nullable by design. Existing selection
-- rows remain NULL; this migration does not infer or backfill their state.
CREATE TYPE "PaymentDebtReservationState" AS ENUM ('ACTIVE', 'APPLIED', 'RELEASED');

ALTER TABLE "payment_debt_selections"
    ADD COLUMN "reservationState" "PaymentDebtReservationState";

-- One payable obligation may have at most one live reservation across all
-- Payments. APPLIED, RELEASED, and historical NULL rows remain auditable and
-- do not prevent a later ACTIVE reservation.
CREATE UNIQUE INDEX "payment_debt_selections_active_chargeItemId_key"
    ON "payment_debt_selections"("chargeItemId")
    WHERE "reservationState" = 'ACTIVE' AND "chargeItemId" IS NOT NULL;

CREATE UNIQUE INDEX "payment_debt_selections_active_adjustmentId_key"
    ON "payment_debt_selections"("adjustmentId")
    WHERE "reservationState" = 'ACTIVE' AND "adjustmentId" IS NOT NULL;
