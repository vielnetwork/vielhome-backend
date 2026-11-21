-- Explicit financial classifications for the manager/accountant income view.
-- Existing ChargeBatches stay immutable; only new batches may use these values.
ALTER TYPE "ChargeKind" ADD VALUE IF NOT EXISTS 'AD_HOC';
ALTER TYPE "ChargeKind" ADD VALUE IF NOT EXISTS 'COST_RECOVERY';
ALTER TYPE "ChargeKind" ADD VALUE IF NOT EXISTS 'SERVICE_RENTAL';
