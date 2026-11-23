ALTER TABLE "backoffice_owner_passkeys"
  ADD COLUMN "challenge" TEXT,
  ADD COLUMN "challengeExpiresAt" TIMESTAMP(3);
