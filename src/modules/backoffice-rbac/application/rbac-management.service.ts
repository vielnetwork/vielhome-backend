import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import { ConflictError, NotFoundAppError } from '../../../common/errors/app-error';
import { BackofficeRbacRepository } from '../infrastructure/repositories/backoffice-rbac.repository';

/**
 * 21_ADRs > ADR-099 §6 — backend-only RBAC management surface (no
 * frontend — UI is an explicit ADR-099 non-goal). Every mutation here
 * writes an `AuditLog` entry (ADR-098 item 7) and REQUIRES a real acting
 * `Person` — unlike the deterministic seed (`prisma/seed/rbac.seed.ts`),
 * which is the only place a null actor / `SYSTEM_SEED` source is valid.
 * Controllers calling this service are gated by the LEGACY
 * `PlatformRolesGuard` (`@PlatformRoles('PLATFORM_ADMIN')`), not the new
 * permission system — see `RbacManagementController`'s own doc comment
 * for the bootstrap reasoning.
 */
@Injectable()
export class RbacManagementService {
  constructor(
    private readonly rbac: BackofficeRbacRepository,
    private readonly audit: AuditService,
  ) {}

  listRoles() {
    return this.rbac.listRoles();
  }

  listPermissions() {
    return this.rbac.listPermissions();
  }

  listActiveRolesForStaff(staffId: string) {
    return this.rbac.listActiveStaffRolesForStaff(staffId);
  }

  async assignRole(staffId: string, roleId: string, actorPersonId: string, requestId?: string) {
    const role = await this.rbac.getRoleById(roleId);
    if (!role) throw new NotFoundAppError('Role not found.');

    const existing = await this.rbac.getActiveStaffRole(staffId, roleId);
    if (existing) {
      throw new ConflictError('This staff member already holds this role.');
    }

    const created = await this.rbac.createStaffRole(staffId, roleId, actorPersonId);
    await this.audit.record({
      actorId: actorPersonId,
      action: 'StaffRoleAssigned',
      entityType: 'StaffRole',
      entityId: created.id,
      metadata: { staffId, roleId, roleName: role.name },
      requestId,
    });
    return created;
  }

  async revokeRole(staffRoleId: string, actorPersonId: string, requestId?: string) {
    const current = await this.rbac.getStaffRoleById(staffRoleId);
    if (!current || current.revokedAt) {
      throw new NotFoundAppError('Active role grant not found.');
    }

    const revoked = await this.rbac.revokeStaffRole(staffRoleId, actorPersonId);
    await this.audit.record({
      actorId: actorPersonId,
      action: 'StaffRoleRevoked',
      entityType: 'StaffRole',
      entityId: staffRoleId,
      metadata: { staffId: current.staffId, roleId: current.roleId },
      requestId,
    });
    return revoked;
  }

  async grantPermission(
    roleId: string,
    permissionKey: PermissionKey,
    actorPersonId: string,
    requestId?: string,
  ) {
    const role = await this.rbac.getRoleById(roleId);
    if (!role) throw new NotFoundAppError('Role not found.');
    const permission = await this.rbac.getPermissionByKey(permissionKey);
    if (!permission) throw new NotFoundAppError('Permission not found.');

    const existing = await this.rbac.getActiveRolePermission(roleId, permission.id);
    if (existing) {
      throw new ConflictError('This role already has this permission.');
    }

    const created = await this.rbac.createRolePermission(roleId, permission.id, actorPersonId);
    await this.audit.record({
      actorId: actorPersonId,
      action: 'RolePermissionGranted',
      entityType: 'RolePermission',
      entityId: created.id,
      metadata: { roleId, roleName: role.name, permissionKey },
      requestId,
    });
    return created;
  }

  async revokePermission(rolePermissionId: string, actorPersonId: string, requestId?: string) {
    const current = await this.rbac.getRolePermissionById(rolePermissionId);
    if (!current || current.revokedAt) {
      throw new NotFoundAppError('Active role-permission grant not found.');
    }

    const revoked = await this.rbac.revokeRolePermission(rolePermissionId, actorPersonId);
    await this.audit.record({
      actorId: actorPersonId,
      action: 'RolePermissionRevoked',
      entityType: 'RolePermission',
      entityId: rolePermissionId,
      metadata: { roleId: current.roleId, permissionId: current.permissionId },
      requestId,
    });
    return revoked;
  }
}
