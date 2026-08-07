-- Cases hardening: durable idempotency and concurrency-safe anomaly detection.
ALTER TABLE "enforcement_actions"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "effectApplied" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "previousTargetState" TEXT,
  ADD COLUMN "effectReversedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "enforcement_actions_idempotencyKey_key"
  ON "enforcement_actions"("idempotencyKey");

ALTER TABLE "compliance_cases"
  ADD COLUMN "activeDetectionKey" TEXT;

CREATE UNIQUE INDEX "compliance_cases_activeDetectionKey_key"
  ON "compliance_cases"("activeDetectionKey");
