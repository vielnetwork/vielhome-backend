CREATE TABLE "backoffice_owner_passkeys" (
  "ownerKey" TEXT NOT NULL,
  "googleSubject" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "publicKey" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "backoffice_owner_passkeys_pkey" PRIMARY KEY ("ownerKey"),
  CONSTRAINT "backoffice_owner_passkeys_single_owner" CHECK ("ownerKey" = 'platform-owner'),
  CONSTRAINT "backoffice_owner_passkeys_counter_nonnegative" CHECK ("counter" >= 0)
);
CREATE UNIQUE INDEX "backoffice_owner_passkeys_googleSubject_key" ON "backoffice_owner_passkeys"("googleSubject");
CREATE UNIQUE INDEX "backoffice_owner_passkeys_credentialId_key" ON "backoffice_owner_passkeys"("credentialId");
