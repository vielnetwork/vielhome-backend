-- ADR-099 (architecture: ADR-098) — Backoffice RBAC Foundation.
-- Additive only: no existing table, column, or enum is altered or dropped.
-- PlatformStaff / PlatformStaffRole are untouched (Bridge Migration).

-- CreateEnum
CREATE TYPE "PermissionKey" AS ENUM (
  'USER_VIEW',
  'USER_EDIT',
  'BUILDING_VIEW',
  'BUILDING_EDIT',
  'MARKETPLACE_REVIEW',
  'MARKETPLACE_APPROVE',
  'FINANCE_VIEW',
  'FINANCE_REFUND',
  'AUDIT_VIEW',
  'SYSTEM_SETTINGS',
  'FEATURE_FLAGS'
);

-- CreateTable
CREATE TABLE "rbac_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rbac_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rbac_permissions" (
    "id" TEXT NOT NULL,
    "key" "PermissionKey" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rbac_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_roles" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "addedById" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rbac_roles_name_key" ON "rbac_roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "rbac_permissions_key_key" ON "rbac_permissions"("key");

-- CreateIndex
CREATE INDEX "staff_roles_staffId_idx" ON "staff_roles"("staffId");

-- CreateIndex
CREATE INDEX "staff_roles_roleId_idx" ON "staff_roles"("roleId");

-- CreateIndex
-- ADR-099: at most one ACTIVE (revokedAt IS NULL) grant per (staffId, roleId).
-- Deliberately a partial unique index, not `@@unique([staffId, roleId])` —
-- a plain unique constraint would forbid ever re-granting a role after a
-- revoke; a partial index scoped to the still-open row is the only way to
-- enforce "at most one currently active" while still preserving every past
-- (closed) grant as its own row.
CREATE UNIQUE INDEX "staff_roles_staffId_roleId_active_key"
  ON "staff_roles"("staffId", "roleId")
  WHERE "revokedAt" IS NULL;

-- CreateIndex
CREATE INDEX "role_permissions_roleId_idx" ON "role_permissions"("roleId");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
-- ADR-099: same rationale as staff_roles_staffId_roleId_active_key above —
-- at most one ACTIVE (revokedAt IS NULL) grant per (roleId, permissionId).
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_active_key"
  ON "role_permissions"("roleId", "permissionId")
  WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "platform_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "rbac_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "rbac_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "rbac_permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
