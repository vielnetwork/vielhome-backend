import { BackOfficeRepository } from './backoffice.repository';

function setup(
  options: {
    suspended?: boolean;
    targetStaff?: { id: string; role: string; isActive: boolean } | null;
    actorRole?: string;
    enforcement?: boolean;
    changed?: number;
    otherAdmins?: number;
  } = {},
) {
  const tx = {
    $executeRaw: jest.fn(),
    platformStaff: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'actor-staff',
        role: options.actorRole ?? 'PLATFORM_ADMIN',
        isActive: true,
      }),
      count: jest.fn().mockResolvedValue(options.otherAdmins ?? 1),
    },
    person: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'target',
        isSuspended: options.suspended ?? false,
        isBackofficeApproved: false,
        platformStaff: options.targetStaff ?? null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: options.changed ?? 1 }),
    },
    enforcementAction: {
      findFirst: jest.fn().mockResolvedValue(options.enforcement ? { id: 'enforcement' } : null),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
  return { repo: new BackOfficeRepository(prisma as never), tx };
}

describe('BackOfficeRepository user mutation hardening', () => {
  it('returns NOT_FOUND for an unknown target without mutation or audit', async () => {
    const { repo, tx } = setup();
    tx.person.findUnique.mockResolvedValue(null);
    await expect(
      repo.changePersonSuspensionAtomically({
        targetPersonId: 'missing',
        actorPersonId: 'actor',
        suspend: true,
        reason: 'risk',
        requestId: 'req',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tx.person.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('atomically suspends, revokes refresh tokens and writes authoritative audit', async () => {
    const { repo, tx } = setup();
    await expect(
      repo.changePersonSuspensionAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        suspend: true,
        reason: 'risk',
        requestId: 'req',
      }),
    ).resolves.toEqual({ personId: 'target', isSuspended: true });
    expect(tx.person.updateMany).toHaveBeenCalledWith({
      where: { id: 'target', isSuspended: false },
      data: { isSuspended: true },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { personId: 'target', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PersonSuspendedByAdmin',
        metadata: { previousValue: false, newValue: true },
      }),
    });
  });

  it.each([
    ['self-target', { targetPersonId: 'actor', actorPersonId: 'actor', suspend: true }],
    [
      'same-state/CAS loss',
      { targetPersonId: 'target', actorPersonId: 'actor', suspend: true, changed: 0 },
    ],
  ])('rejects %s without audit', async (_label, input) => {
    const { changed, ...params } = input as typeof input & { changed?: number };
    const { repo, tx } = setup({ changed });
    await expect(
      repo.changePersonSuspensionAtomically({ ...params, reason: 'reason', requestId: 'req' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('blocks equal/higher active staff and the last usable admin', async () => {
    const equal = setup({
      actorRole: 'SENIOR_REVIEWER',
      targetStaff: { id: 's2', role: 'SENIOR_REVIEWER', isActive: true },
    });
    await expect(
      equal.repo.changePersonSuspensionAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        suspend: true,
        reason: 'x',
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const last = setup({
      actorRole: 'PLATFORM_ADMIN',
      targetStaff: { id: 's2', role: 'PLATFORM_ADMIN', isActive: true },
      otherAdmins: 0,
    });
    await expect(
      last.repo.changePersonSuspensionAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        suspend: true,
        reason: 'x',
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('blocks direct reinstate while active enforcement exists', async () => {
    const { repo, tx } = setup({ suspended: true, enforcement: true });
    await expect(
      repo.changePersonSuspensionAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        suspend: false,
        reason: 'x',
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.person.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('guards approval with CAS and one atomic audit', async () => {
    const { repo, tx } = setup();
    await expect(
      repo.changePersonBackofficeApprovalAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        approved: true,
        reason: 'ok',
        requestId: 'r',
      }),
    ).resolves.toEqual({ personId: 'target', isBackofficeApproved: true });
    expect(tx.person.updateMany).toHaveBeenCalledWith({
      where: { id: 'target', isBackofficeApproved: false },
      data: { isBackofficeApproved: true },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('allows only one winner for concurrent same-state suspension requests', async () => {
    const { repo, tx } = setup();
    tx.person.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const results = await Promise.allSettled([
      repo.changePersonSuspensionAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        suspend: true,
        reason: 'one',
        requestId: 'r1',
      }),
      repo.changePersonSuspensionAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        suspend: true,
        reason: 'two',
        requestId: 'r2',
      }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('allows only one winner for concurrent same-state approval requests', async () => {
    const { repo, tx } = setup();
    tx.person.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const results = await Promise.allSettled([
      repo.changePersonBackofficeApprovalAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        approved: true,
        requestId: 'r1',
      }),
      repo.changePersonBackofficeApprovalAtomically({
        targetPersonId: 'target',
        actorPersonId: 'actor',
        approved: true,
        requestId: 'r2',
      }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
