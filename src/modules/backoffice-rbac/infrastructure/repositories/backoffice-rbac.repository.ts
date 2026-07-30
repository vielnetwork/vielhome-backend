import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * 21_ADRs > ADR-099 — persistence for the Backoffice RBAC Foundation.
 * Repositories expose domain operations and never contain business rules
 * (11_Backend_Architecture > Repository Pattern) — every conflict/
 * not-found decision lives in `RbacManagementService`, not here.
 */
@Injectable()
export class BackofficeRbacRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Live resolution (ADR-098 item 5) -------------------------------

  /**
   * A single query joining `StaffRole` (active only) -> `Role` ->
   * `RolePermission` (active only) -> `Permission`, returning the
   * distinct set of permission keys a staff member currently holds
   * across every role they hold. No caching here — see
   * `PermissionResolverService`'s own doc comment for why.
   */
  async getEffectivePermissionKeysForStaff(staffId: string): Promise<PermissionKey[]> {
    const staffRoles = await this.prisma.staffRole.findMany({
      where: { staffId, revokedAt: null },
      include: {
        role: {
          include: {
            rolePermissions: {
              where: { revokedAt: null },
              include: { permission: true },
            },
          },
        },
      },
    });

    const keys = new Set<PermissionKey>();
    for (const staffRole of staffRoles) {
      for (const rolePermission of staffRole.role.rolePermissions) {
        keys.add(rolePermission.permission.key);
      }
    }
    return [...keys];
  }

  // --- Reference data --------------------------------------------------

  listRoles() {
    return this.prisma.role.findMany({ orderBy: { name: 'asc' } });
  }

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  getRoleById(id: string) {
    return this.prisma.role.findUnique({ where: { id } });
  }

  getPermissionByKey(key: PermissionKey) {
    return this.prisma.permission.findUnique({ where: { key } });
  }

  // --- Staff <-> Role (ADR-099 §6 management surface) ------------------

  getActiveStaffRole(staffId: string, roleId: string) {
    return this.prisma.staffRole.findFirst({ where: { staffId, roleId, revokedAt: null } });
  }

  getStaffRoleById(id: string) {
    return this.prisma.staffRole.findUnique({ where: { id } });
  }

  listActiveStaffRolesForStaff(staffId: string) {
    return this.prisma.staffRole.findMany({
      where: { staffId, revokedAt: null },
      include: { role: true },
    });
  }

  createStaffRole(staffId: string, roleId: string, assignedById: string | null) {
    return this.prisma.staffRole.create({ data: { staffId, roleId, assignedById } });
  }

  revokeStaffRole(id: string, revokedById: string | null) {
    return this.prisma.staffRole.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById },
    });
  }

  // --- Role <-> Permission (ADR-099 §6 management surface) -------------

  getActiveRolePermission(roleId: string, permissionId: string) {
    return this.prisma.rolePermission.findFirst({ where: { roleId, permissionId, revokedAt: null } });
  }

  getRolePermissionById(id: string) {
    return this.prisma.rolePermission.findUnique({ where: { id } });
  }

  createRolePermission(roleId: string, permissionId: string, addedById: string | null) {
    return this.prisma.rolePermission.create({ data: { roleId, permissionId, addedById } });
  }

  revokeRolePermission(id: string, revokedById: string | null) {
    return this.prisma.rolePermission.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById },
    });
  }
}
