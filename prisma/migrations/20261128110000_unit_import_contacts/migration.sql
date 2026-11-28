CREATE TABLE "unit_import_contacts" (
  "unitId" TEXT NOT NULL REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "MembershipRole" NOT NULL,
  "phone" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "leaseEndDate" TIMESTAMP(3),
  "invitedAt" TIMESTAMP(3),
  "invitedById" TEXT,
  "acceptedAt" TIMESTAMP(3),
  PRIMARY KEY ("unitId", "role"),
  CHECK ("role" IN ('OWNER', 'TENANT'))
);
CREATE INDEX "unit_import_contacts_phone_idx" ON "unit_import_contacts"("phone");
