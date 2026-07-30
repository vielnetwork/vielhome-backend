import { PermissionResolverService } from './permission-resolver.service';

describe('PermissionResolverService', () => {
  it('resolves an empty set when the caller has no active PlatformStaff row', async () => {
    const backOffice = { getActivePlatformStaff: jest.fn().mockResolvedValue(null) } as never;
    const rbac = { getEffectivePermissionKeysForStaff: jest.fn() } as never;
    const service = new PermissionResolverService(backOffice, rbac);

    const result = await service.resolve('person-1');

    expect(result).toEqual(new Set());
    expect((rbac as { getEffectivePermissionKeysForStaff: jest.Mock }).getEffectivePermissionKeysForStaff).not.toHaveBeenCalled();
  });

  it('resolves the union of permission keys across every current role a staff member holds', async () => {
    const backOffice = {
      getActivePlatformStaff: jest.fn().mockResolvedValue({ id: 'staff-1', isActive: true }),
    } as never;
    const rbac = {
      getEffectivePermissionKeysForStaff: jest
        .fn()
        .mockResolvedValue(['MARKETPLACE_REVIEW', 'MARKETPLACE_APPROVE', 'USER_VIEW']),
    } as never;
    const service = new PermissionResolverService(backOffice, rbac);

    const result = await service.resolve('person-1');

    expect(result).toEqual(new Set(['MARKETPLACE_REVIEW', 'MARKETPLACE_APPROVE', 'USER_VIEW']));
    expect(
      (rbac as { getEffectivePermissionKeysForStaff: jest.Mock }).getEffectivePermissionKeysForStaff,
    ).toHaveBeenCalledWith('staff-1');
  });

  it('resolves an empty set when the staff member holds no current role', async () => {
    const backOffice = {
      getActivePlatformStaff: jest.fn().mockResolvedValue({ id: 'staff-1', isActive: true }),
    } as never;
    const rbac = {
      getEffectivePermissionKeysForStaff: jest.fn().mockResolvedValue([]),
    } as never;
    const service = new PermissionResolverService(backOffice, rbac);

    await expect(service.resolve('person-1')).resolves.toEqual(new Set());
  });
});
