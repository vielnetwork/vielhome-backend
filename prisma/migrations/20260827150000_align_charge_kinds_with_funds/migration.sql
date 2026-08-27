-- Additive only: SPECIAL remains in the enum for historical compatibility,
-- and no existing ChargeBatch row is rewritten or reclassified.
ALTER TYPE "ChargeKind" ADD VALUE IF NOT EXISTS 'EMERGENCY';
ALTER TYPE "ChargeKind" ADD VALUE IF NOT EXISTS 'INSURANCE';
