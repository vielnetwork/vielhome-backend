import { RbacManagementService } from './rbac-management.service';
import { ConflictError, NotFoundAppError } from '../../../common/errors/app-error';

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const rbac = {
    getRoleById: jest.fn().mockResolvedValue({ id: 'role-1', name: 'Marketplace Admin' }),
    getActiveStaffRole: jest.fn().mockResolvedValue(null),
    createStaffRole: jest.fn().mockResolvedValue({ id: 'sr-1' }),
    getStaffRoleById: jest.fn().mockResolvedValue({ id: 'sr-1', staffId: 's1', roleId: 'role-1', revokedAt: null }),
    revokeStaffRole: jest.fn().mockResolvedValue({ id: 'sr-1', revokedAt: new Date() }),
    getPermissionByKey: jest.fn().mockResolvedValue({ id: 'perm-1', key: 'MARKETPLACE_APPROVE' }),
    getActiveRolePermission: jest.fn().mockResolvedValue(null),
    createRolePermission: jest.fn().mockResolvedValue({ id: 'rp-1' }),
    getRolePermissionById: jest
      .fn()
      .mockResolvedValue({ id: 'rp-1', roleId: 'role-1', permissionId: 'perm-1', revokedAt: null }),
    revokeRolePermission: jest.fn().mockResolvedValue({ id: 'rp-1', revokedAt: new Date() }),
    listRoles: jest.fn(),
    listPermissions: jest.fn(),
    ...overrides,
  } as never;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
  return { service: new RbacManagementService(rbac, audit), rbac, audit };
}

describe('RbacManagementService', () => {
  describe('assignRole', () => {
    it('creates a StaffRole grant and writes an AuditLog entry', async () => {
      const { service, audit } = makeService();

      const result = await service.assignRole('staff-1', 'role-1', 'actor-1', 'req-1');

      expect(result).toEqual({ id: 'sr-1' });
      expect((audit as { record: jest.Mock }).record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'actor-1', action: 'StaffRoleAssigned', entityType: 'StaffRole' }),
      );
    });

    it('throws NotFoundAppError for an unknown role', async () => {
      const { service } = makeService({ getRoleById: jest.fn().mockResolvedValue(null) });
      await expect(service.assignRole('staff-1', 'missing-role', 'actor-1')).rejects.toBeInstanceOf(
        NotFoundAppError,
      );
    });

    it('throws ConflictError when the staff member already holds an active grant of this role', async () => {
      const { service } = makeService({
        getActiveStaffRole: jest.fn().mockResolvedValue({ id: 'sr-existing' }),
      });
      await expect(service.assignRole('staff-1', 'role-1', 'actor-1')).rejects.toBeInstanceOf(
        ConflictError,
      );
    });
  });

  describe('revokeRole', () => {
    it('closes the active grant and writes an AuditLog entry', async () => {
      const { service, audit } = makeService();
      const result = await service.revokeRole('sr-1', 'actor-1', 'req-1');
      expect(result.revokedAt).toBeInstanceOf(Date);
      expect((audit as { record: jest.Mock }).record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'StaffRoleRevoked' }),
      );
    });

    it('throws NotFoundAppError when the grant is already revoked', async () => {
      const { service } = makeService({
        getStaffRoleById: jest
          .fn()
          .mockResolvedValue({ id: 'sr-1', staffId: 's1', roleId: 'role-1', revokedAt: new Date() }),
      });
      await expect(service.revokeRole('sr-1', 'actor-1')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('grantPermission', () => {
    it('creates a RolePermission grant and writes an AuditLog entry', async () => {
      const { service, audit } = makeService();
      const result = await service.grantPermission('role-1', 'MARKETPLACE_APPROVE', 'actor-1', 'req-1');
      expect(result).toEqual({ id: 'rp-1' });
      expect((audit as { record: jest.Mock }).record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RolePermissionGranted', entityType: 'RolePermission' }),
      );
    });

    it('throws ConflictError when the role already has this permission actively granted', async () => {
      const { service } = makeService({
        getActiveRolePermission: jest.fn().mockResolvedValue({ id: 'rp-existing' }),
      });
      await expect(
        service.grantPermission('role-1', 'MARKETPLACE_APPROVE', 'actor-1'),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('revokePermission', () => {
    it('closes the active grant and writes an AuditLog entry', async () => {
      const { service, audit } = makeService();
      const result = await service.revokePermission('rp-1', 'actor-1', 'req-1');
      expect(result.revokedAt).toBeInstanceOf(Date);
      expect((audit as { record: jest.Mock }).record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RolePermissionRevoked' }),
      );
    });

    it('throws NotFoundAppError when the grant is already revoked', async () => {
      const { service } = makeService({
        getRolePermissionById: jest
          .fn()
          .mockResolvedValue({ id: 'rp-1', roleId: 'role-1', permissionId: 'perm-1', revokedAt: new Date() }),
      });
      await expect(service.revokePermission('rp-1', 'actor-1')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });
});
