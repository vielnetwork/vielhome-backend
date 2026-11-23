import { createHmac } from 'node:crypto';
import { OwnerRbacController } from './owner-rbac.controller';

describe('owner role request authorization', () => {
  const secret = 'owner-role-bridge-test-secret-32-characters';
  const originalSecret = process.env.BACKOFFICE_OWNER_ROLE_BRIDGE_SECRET;
  const originalActor = process.env.BACKOFFICE_OWNER_ACTOR_PHONE;

  beforeEach(() => {
    process.env.BACKOFFICE_OWNER_ROLE_BRIDGE_SECRET = secret;
    process.env.BACKOFFICE_OWNER_ACTOR_PHONE = '09120704409';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BACKOFFICE_OWNER_ROLE_BRIDGE_SECRET;
    else process.env.BACKOFFICE_OWNER_ROLE_BRIDGE_SECRET = originalSecret;
    if (originalActor === undefined) delete process.env.BACKOFFICE_OWNER_ACTOR_PHONE;
    else process.env.BACKOFFICE_OWNER_ACTOR_PHONE = originalActor;
  });

  it('rejects a changed request and a replay before either can alter roles', async () => {
    const createMany = jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const assign = jest.fn().mockResolvedValue({ id: 'assignment' });
    const controller = new OwnerRbacController({
      person: { findUnique: jest.fn().mockResolvedValue({ id: 'owner-person' }) },
      backofficeOwnerPasskey: { findUnique: jest.fn().mockResolvedValue({ googleSubject: 'owner-google' }) },
      backofficeOwnerRoleRequest: { createMany, deleteMany: jest.fn() },
    } as never, { assign } as never, {} as never);
    const nonce = 'a'.repeat(48);
    const payload = JSON.stringify({
      nonce, expires: Date.now() + 20_000, subject: 'owner-google',
      action: 'assign', phone: '09120000000', id: 'role',
    });
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');

    await expect(controller.manage(signature, payload.replace('role', 'other-role'))).rejects.toThrow();
    expect(createMany).not.toHaveBeenCalled();
    await expect(controller.manage(signature, payload)).resolves.toEqual({ id: 'assignment' });
    await expect(controller.manage(signature, payload)).rejects.toThrow();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('09120000000', 'role', 'owner-person', nonce);
  });
});
