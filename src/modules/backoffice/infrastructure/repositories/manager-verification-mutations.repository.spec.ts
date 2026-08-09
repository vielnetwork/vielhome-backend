import { BackOfficeRepository } from './backoffice.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConflictError } from '../../../../common/errors/app-error';

function createHarness() {
  const kase = {
    id: 'case-1',
    buildingId: 'building-1',
    membershipId: 'membership-1',
    candidateId: 'candidate-1',
    status: 'PENDING',
    requiredApprovalPercent: 30,
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    managerVerificationCase: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(kase),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...kase, status: 'VERIFIED' }),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ ...kase, id: 'restore-1', status: 'VERIFIED' }),
    },
    managerVerificationApproval: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'approval-1' }),
      count: jest.fn().mockResolvedValue(1),
    },
    membership: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ personId: 'owner-1' }, { personId: 'owner-2' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    building: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    kase,
    tx,
    repository: new BackOfficeRepository(prisma as unknown as PrismaService),
  };
}

describe('BackOfficeRepository manager verification mutation hardening', () => {
  it.each([
    ['APPROVE', 'VERIFIED', 'VERIFIED', true, null],
    ['REJECT', 'REJECTED', 'FORMER', false, expect.any(Date)],
    ['SUSPEND', 'SUSPENDED', 'SUSPENDED', true, null],
  ] as const)(
    'atomically applies %s case, membership, recovery and audit effects',
    async (decision, status, managerState, isCurrent, endedAt) => {
      const { repository, tx } = createHarness();
      await repository.decideManagerVerificationCaseAtomically({
        id: 'case-1',
        buildingId: 'building-1',
        membershipId: 'membership-1',
        candidateId: 'candidate-1',
        status,
        decision,
        reviewedById: 'reviewer-1',
        reason: 'reason',
        requestId: 'request-1',
      });

      expect(tx.managerVerificationCase.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'case-1', status: 'PENDING' } }),
      );
      expect(tx.membership.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ managerState, isCurrent, endedAt }),
        }),
      );
      expect(tx.building.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            recoveryModeEnteredAt: decision === 'APPROVE' ? null : expect.any(Date),
          },
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a losing decision CAS before membership, recovery or audit side effects', async () => {
    const { repository, tx } = createHarness();
    tx.managerVerificationCase.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.decideManagerVerificationCaseAtomically({
        id: 'case-1',
        buildingId: 'building-1',
        membershipId: 'membership-1',
        candidateId: 'candidate-1',
        status: 'VERIFIED',
        decision: 'APPROVE',
        reviewedById: 'reviewer-1',
        requestId: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tx.membership.updateMany).not.toHaveBeenCalled();
    expect(tx.building.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an already-consumed restore before creating any child or side effect', async () => {
    const { repository, tx, kase } = createHarness();
    tx.managerVerificationCase.findUnique.mockResolvedValue({ ...kase, status: 'SUSPENDED' });
    tx.managerVerificationCase.findFirst.mockResolvedValue({ id: 'existing-restore' });

    await expect(
      repository.restoreManagerVerificationCaseAtomically({
        suspendedCaseId: 'case-1',
        reviewerPersonId: 'reviewer-1',
        requestId: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tx.managerVerificationCase.create).not.toHaveBeenCalled();
    expect(tx.membership.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('creates one restore child and restores the same current membership atomically', async () => {
    const { repository, tx, kase } = createHarness();
    tx.managerVerificationCase.findUnique.mockResolvedValue({ ...kase, status: 'SUSPENDED' });

    await repository.restoreManagerVerificationCaseAtomically({
      suspendedCaseId: 'case-1',
      reviewerPersonId: 'reviewer-1',
      requestId: 'request-1',
    });

    expect(tx.managerVerificationCase.create).toHaveBeenCalledTimes(1);
    expect(tx.membership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { managerState: 'VERIFIED', isCurrent: true, endedAt: null },
      }),
    );
    expect(tx.building.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { recoveryModeEnteredAt: null } }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('keeps a below-threshold owner vote pending without finalization side effects', async () => {
    const { repository, tx } = createHarness();
    tx.managerVerificationApproval.count.mockResolvedValue(1);
    tx.membership.findMany.mockResolvedValue([
      { personId: 'owner-1' },
      { personId: 'owner-2' },
      { personId: 'owner-3' },
      { personId: 'owner-4' },
    ]);

    const result = await repository.castManagerVerificationApprovalAtomically({
      caseId: 'case-1',
      ownerPersonId: 'owner-1',
      requestId: 'request-1',
    });

    expect(result.resolved).toBe(false);
    expect(tx.managerVerificationCase.updateMany).not.toHaveBeenCalled();
    expect(tx.membership.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('finalizes an exact-threshold owner vote once inside the transaction', async () => {
    const { repository, tx } = createHarness();
    tx.managerVerificationApproval.count.mockResolvedValue(2);
    tx.membership.findMany.mockResolvedValue([
      { personId: 'owner-1' },
      { personId: 'owner-2' },
      { personId: 'owner-3' },
      { personId: 'owner-4' },
    ]);

    const result = await repository.castManagerVerificationApprovalAtomically({
      caseId: 'case-1',
      ownerPersonId: 'owner-2',
      requestId: 'request-2',
    });

    expect(result.resolved).toBe(true);
    expect(tx.managerVerificationCase.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.membership.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.building.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a duplicate pending appeal before creating or auditing another case', async () => {
    const { repository, tx, kase } = createHarness();
    tx.managerVerificationCase.findUnique.mockResolvedValue({ ...kase, status: 'REJECTED' });
    tx.managerVerificationCase.findFirst.mockResolvedValue({ id: 'active-appeal' });

    await expect(
      repository.createManagerVerificationAppealAtomically({
        sourceCaseId: 'case-1',
        callerPersonId: 'candidate-1',
        requestId: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tx.managerVerificationCase.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
