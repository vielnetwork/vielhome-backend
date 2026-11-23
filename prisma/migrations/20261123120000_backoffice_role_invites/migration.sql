ALTER TYPE "PlatformStaffRole" ADD VALUE 'RBAC_ONLY';
CREATE TABLE "backoffice_role_invites" (
  "id" TEXT PRIMARY KEY,
  "phone" TEXT NOT NULL,
  "roleId" TEXT NOT NULL REFERENCES "rbac_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "invitedById" TEXT NOT NULL REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3)
);
CREATE INDEX "backoffice_role_invites_phone_idx" ON "backoffice_role_invites"("phone");
