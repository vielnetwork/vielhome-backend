import {
  BootstrapBackofficeAdminService,
  DEFAULT_BOOTSTRAP_ADMIN_NAME,
  DEFAULT_BOOTSTRAP_ROLE_NAME,
} from './bootstrap-backoffice-admin.service';
import { BackofficeRbacRepository } from '../../backoffice-rbac/infrastructure/repositories/backoffice-rbac.repository';
import { BackofficeBootstrapRepository } from '../infrastructure/repositories/backoffice-bootstrap.repository';
import { NotFoundAppError, ValidationError } from '../../../common/errors/app-error';

function makeRbac(overrides: Partial<Record<string, jest.Mock>> = {}): BackofficeRbacRepository {
  return {
    getRoleByName: jest.fn().mockResolvedValue({ id: 'role-1', name: DEFAULT_BOOTSTRAP_ROLE_NAME }),
    ...overrides,
  } as unknown as BackofficeRbacRepository;
}

function makeBootstrapRepo(
  overrides: Partial<Record<string, jest.Mock>> = {},
): BackofficeBootstrapRepository {
  return {
    findActiveGrantsForRole: jest.fn().mockResolvedValue([]),
    createBootstrapAdmin: jest.fn().mockResolvedValue({
      person: { id: 'person-1', phone: '+989121234567', fullName: DEFAULT_BOOTSTRAP_ADMIN_NAME },
      platformStaff: { id: 'staff-1' },
      staffRole: { id: 'staff-role-1' },
    }),
    ...overrides,
  } as unknown as BackofficeBootstrapRepository;
}

describe('BootstrapBackofficeAdminService', () => {
  it('throws NotFoundAppError when the target role does not exist in the seed catalog', async () => {
    const rbac = makeRbac({ getRoleByName: jest.fn().mockResolvedValue(null) });
    const bootstrapRepo = makeBootstrapRepo();
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    await expect(service.run({ phone: '+989121234567' })).rejects.toBeInstanceOf(NotFoundAppError);
    expect(bootstrapRepo.findActiveGrantsForRole).not.toHaveBeenCalled();
  });

  it('returns ALREADY_EXISTS and makes no changes when an active holder already exists — no phone required', async () => {
    const existingHolder = {
      id: 'staff-role-existing',
      staffId: 'staff-existing',
      staff: {
        person: { id: 'person-existing', phone: '+989120000099', fullName: 'Existing Admin' },
      },
    };
    const rbac = makeRbac();
    const bootstrapRepo = makeBootstrapRepo({
      findActiveGrantsForRole: jest.fn().mockResolvedValue([existingHolder]),
    });
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    const result = await service.run({});

    expect(result).toEqual({
      status: 'ALREADY_EXISTS',
      roleName: DEFAULT_BOOTSTRAP_ROLE_NAME,
      admin: {
        personId: 'person-existing',
        phone: '+989120000099',
        fullName: 'Existing Admin',
        staffId: 'staff-existing',
        staffRoleId: 'staff-role-existing',
      },
    });
    expect(bootstrapRepo.createBootstrapAdmin).not.toHaveBeenCalled();
  });

  it('throws ValidationError when no phone is available and no admin exists yet', async () => {
    const rbac = makeRbac();
    const bootstrapRepo = makeBootstrapRepo();
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    await expect(service.run({})).rejects.toBeInstanceOf(ValidationError);
    expect(bootstrapRepo.createBootstrapAdmin).not.toHaveBeenCalled();
  });

  it('throws ValidationError for an invalid phone number and never creates anything', async () => {
    const rbac = makeRbac();
    const bootstrapRepo = makeBootstrapRepo();
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    await expect(service.run({ phone: 'not-a-phone' })).rejects.toBeInstanceOf(ValidationError);
    expect(bootstrapRepo.createBootstrapAdmin).not.toHaveBeenCalled();
  });

  it('normalizes the phone and applies the default display name when none is given', async () => {
    const rbac = makeRbac();
    const bootstrapRepo = makeBootstrapRepo();
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    const result = await service.run({ phone: '09121234567' });

    expect(bootstrapRepo.createBootstrapAdmin).toHaveBeenCalledWith({
      roleId: 'role-1',
      roleName: DEFAULT_BOOTSTRAP_ROLE_NAME,
      phone: '+989121234567',
      fullName: DEFAULT_BOOTSTRAP_ADMIN_NAME,
    });
    expect(result).toEqual({
      status: 'CREATED',
      roleName: DEFAULT_BOOTSTRAP_ROLE_NAME,
      admin: {
        personId: 'person-1',
        phone: '+989121234567',
        fullName: DEFAULT_BOOTSTRAP_ADMIN_NAME,
        staffId: 'staff-1',
        staffRoleId: 'staff-role-1',
      },
    });
  });

  it('trims and reuses a custom fullName when given', async () => {
    const rbac = makeRbac();
    const bootstrapRepo = makeBootstrapRepo();
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    await service.run({ phone: '+989121234567', fullName: '  Ada Lovelace  ' });

    expect(bootstrapRepo.createBootstrapAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: 'Ada Lovelace' }),
    );
  });

  it('honors a custom roleName end-to-end (role lookup, existence check, and creation)', async () => {
    const rbac = makeRbac({
      getRoleByName: jest.fn().mockResolvedValue({ id: 'role-custom', name: 'Custom Role' }),
    });
    const bootstrapRepo = makeBootstrapRepo();
    const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

    await service.run({ phone: '+989121234567', roleName: 'Custom Role' });

    expect(rbac.getRoleByName).toHaveBeenCalledWith('Custom Role');
    expect(bootstrapRepo.findActiveGrantsForRole).toHaveBeenCalledWith('role-custom');
    expect(bootstrapRepo.createBootstrapAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 'role-custom', roleName: 'Custom Role' }),
    );
  });
});
