CREATE TABLE "backoffice_owner_role_requests" (
  "id" TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "backoffice_owner_role_requests_expiresAt_idx"
  ON "backoffice_owner_role_requests"("expiresAt");
