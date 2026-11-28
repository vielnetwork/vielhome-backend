import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FirstChargeVerificationService } from './first-charge-verification.service';

const buildingId = 'building';
const managerId = 'manager';
const membershipId = 'term';
const draftId = 'draft';
const requestId = 'request';

function setup() {
  const tx = {
    $executeRaw: jest.fn(),
    unit: { findMany: jest.fn() },
    membership: {
      findFirst: jest.fn().mockResolvedValue({
        id: membershipId,
        personId: managerId,
        startedAt: new Date(),
        person: { firstName: 'Maryam', lastName: null, fullName: null },
      }),
    },
    chargeBatch: {
      findFirst: jest.fn().mockResolvedValueOnce({ id: draftId }).mockResolvedValue(null),
    },
    chargeVerificationPoll: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => ({ id: 'poll', ...data })),
      update: jest.fn(),
    },
    chargeVerificationBallot: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(11),
    },
    managerVerificationCase: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn() },
  };
  return {
    tx,
    service: new FirstChargeVerificationService({
      ...tx,
      $transaction: async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService),
  };
}

describe('FirstChargeVerificationService', () => {
  it.each([
    [20, 11],
    [21, 0],
  ])(
    'opens the proper verification for a building with %i units and preserves the draft',
    async (unitCount, requiredApprovals) => {
      const { tx, service } = setup();
      const units = Array.from({ length: unitCount }, (_, i) => ({ id: String(i + 1) }));
      tx.unit.findMany.mockResolvedValue(units);
      await expect(
        service.authorizeIssue(buildingId, draftId, managerId, requestId),
      ).rejects.toMatchObject({
        details: { reason: 'FIRST_CHARGE_VERIFICATION_REQUIRED', draftId, approved: false },
      });
      expect(tx.chargeVerificationPoll.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            draftId,
            membershipId,
            requiredApprovals,
            unitIds: requiredApprovals ? units.map(({ id }) => id) : [],
          },
        }),
      );
    },
  );

  it('accepts minutes approved for the current term and only the manager can issue', async () => {
    const { tx, service } = setup();
    tx.chargeBatch.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: draftId })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: draftId })
      .mockResolvedValueOnce(null);
    tx.chargeVerificationPoll.findUnique.mockResolvedValue({
      id: 'poll',
      draftId,
      requiredApprovals: 0,
      draft: { status: 'DRAFT' },
    });
    tx.managerVerificationCase.findFirst.mockResolvedValue({ id: 'approved-minutes' });
    await expect(
      service.authorizeIssue(buildingId, draftId, 'accountant', requestId),
    ).rejects.toMatchObject({ details: { approved: true } });
    await expect(service.authorizeIssue(buildingId, draftId, managerId, requestId)).resolves.toBe(
      membershipId,
    );
    expect(tx.managerVerificationCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { membershipId, boardMinutesStorageKey: { not: null }, status: 'VERIFIED' },
      }),
    );
  });

  it('closes a small-building poll when the 11th unit approves', async () => {
    const { tx, service } = setup();
    tx.chargeVerificationPoll.findUnique.mockResolvedValue({
      id: 'poll',
      membershipId,
      requiredApprovals: 11,
      unitIds: ['unit'],
      draft: { status: 'DRAFT' },
    });
    tx.unit.findMany.mockResolvedValue([{ id: 'unit' }]);
    await expect(
      service.vote(buildingId, 'tenant', 'poll', 'unit', true, requestId),
    ).resolves.toEqual({ recorded: true });
    expect(tx.chargeVerificationBallot.createMany).toHaveBeenCalledWith({
      data: [{ pollId: 'poll', unitId: 'unit', voterId: 'tenant', approved: true }],
      skipDuplicates: true,
    });
    expect(tx.chargeVerificationPoll.update).toHaveBeenCalledWith({
      where: { id: 'poll' },
      data: { approvedAt: expect.any(Date) },
    });
  });

  it('rejects a second vote for a unit and blocks newly added units from an open poll', async () => {
    const { tx, service } = setup();
    tx.chargeVerificationPoll.findUnique.mockResolvedValue({
      id: 'poll',
      membershipId,
      requiredApprovals: 11,
      unitIds: ['unit'],
      draft: { status: 'DRAFT' },
    });
    tx.unit.findMany.mockResolvedValue([{ id: 'unit' }, { id: 'new-unit' }]);
    tx.chargeVerificationBallot.createMany.mockResolvedValue({ count: 0 });
    await expect(
      service.vote(buildingId, 'owner', 'poll', 'unit', true, requestId),
    ).rejects.toThrow('already voted');
    await expect(
      service.vote(buildingId, 'owner', 'poll', 'new-unit', true, requestId),
    ).rejects.toThrow('Only the current owner or tenant');
    expect(tx.chargeVerificationPoll.update).not.toHaveBeenCalled();
  });
});
