CREATE TABLE "accountant_invitations" (
 "id" TEXT PRIMARY KEY,
 "buildingId" TEXT NOT NULL REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "phone" TEXT NOT NULL,
 "invitedById" TEXT NOT NULL REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "acceptedAt" TIMESTAMP(3),
 "cancelledAt" TIMESTAMP(3)
);
CREATE INDEX "accountant_invitations_phone_acceptedAt_cancelledAt_idx" ON "accountant_invitations"("phone","acceptedAt","cancelledAt");
CREATE UNIQUE INDEX "accountant_invites_one_pending" ON "accountant_invitations"("buildingId","phone") WHERE "acceptedAt" IS NULL AND "cancelledAt" IS NULL;
