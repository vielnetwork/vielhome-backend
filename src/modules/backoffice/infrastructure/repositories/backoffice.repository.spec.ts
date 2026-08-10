import { BackOfficeRepository } from './backoffice.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConflictError } from '../../../../common/errors/app-error';

describe('BackOfficeRepository fraud evidence', () => {
  it('appends an attributed evidence row and updates only the compatibility projection atomically', async () => {
    const prisma: {
      fraudCaseEvidence: { create: jest.Mock };
      fraudCase: { update: jest.Mock };
      $transaction: jest.Mock;
    } = {
      fraudCaseEvidence: { create: jest.fn().mockResolvedValue({ id: 'evidence-2' }) },
      fraudCase: {
        update: jest.fn().mockResolvedValue({
          id: 'fraud-1',
          evidenceNotes: 'second observation',
          evidence: [
            { id: 'evidence-1', notes: 'first observation', authorId: 'reviewer-1' },
            { id: 'evidence-2', notes: 'second observation', authorId: 'reviewer-2' },
          ],
        }),
      },
      $transaction: jest.fn((callback: (tx: unknown) => unknown): unknown => callback(prisma)),
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    const result = await repository.addFraudCaseEvidence(
      'fraud-1',
      'second observation',
      'reviewer-2',
    );

    expect(prisma.fraudCaseEvidence.create).toHaveBeenCalledWith({
      data: {
        fraudCaseId: 'fraud-1',
        notes: 'second observation',
        authorId: 'reviewer-2',
      },
    });
    expect(prisma.fraudCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fraud-1' },
        data: { evidenceNotes: 'second observation' },
      }),
    );
    expect(result.evidence).toHaveLength(2);
  });
});

describe('BackOfficeRepository enforcement reversal', () => {
  it('rolls back the appeal decision instead of overwriting a later target change', async () => {
    const action = {
      id: 'action-1',
      type: 'ACCOUNT_SUSPENSION',
      targetType: 'PERSON',
      targetPersonId: 'person-1',
      targetBuildingId: null,
      targetMembershipId: null,
      appealStatus: 'PENDING',
      effectApplied: true,
      effectReversedAt: null,
      previousTargetState: JSON.stringify({ isSuspended: false }),
    };
    const prisma = {
      enforcementAction: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(action),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      person: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn((callback: (tx: unknown) => unknown): unknown => callback(prisma)),
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    await expect(
      repository.decideEnforcementAppeal({
        id: action.id,
        appealStatus: 'OVERTURNED',
        appealDecidedById: 'reviewer-1',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.enforcementAction.update).not.toHaveBeenCalled();
  });
});

describe('BackOfficeRepository compliance mutation CAS', () => {
  it('uses status and assignee snapshot so only one concurrent assignment can win', async () => {
    const prisma = {
      complianceCase: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'case-1',
          status: 'UNDER_INVESTIGATION',
          assignedToId: 'staff-1',
        }),
      },
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    await expect(
      repository.assignComplianceCase('case-1', 'staff-1', 'OPEN', null),
    ).resolves.toMatchObject({ assignedToId: 'staff-1' });
    await expect(
      repository.assignComplianceCase('case-1', 'staff-2', 'OPEN', null),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.complianceCase.updateMany).toHaveBeenCalledWith({
      where: { id: 'case-1', status: 'OPEN', assignedToId: null },
      data: { assignedToId: 'staff-1', status: 'UNDER_INVESTIGATION' },
    });
    expect(prisma.complianceCase.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it('uses the same assignee snapshot for decision-vs-assignment exclusion', async () => {
    const prisma = {
      complianceCase: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'case-1', status: 'CONFIRMED' }),
      },
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    await repository.decideComplianceCase({
      id: 'case-1',
      status: 'CONFIRMED',
      decidedById: 'reviewer-1',
      decisionReason: 'Substantiated',
      expectedStatus: 'UNDER_INVESTIGATION',
      expectedAssignedToId: 'staff-1',
    });

    expect(prisma.complianceCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'case-1',
        status: 'UNDER_INVESTIGATION',
        assignedToId: 'staff-1',
      },
      data: {
        status: 'CONFIRMED',
        decidedById: 'reviewer-1',
        decisionReason: 'Substantiated',
        decidedAt: expect.any(Date),
        activeDetectionKey: null,
      },
    });
  });

  it('allows only one winner when assignment and decision share the same snapshot', async () => {
    const prisma = {
      complianceCase: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'case-1',
          status: 'UNDER_INVESTIGATION',
          assignedToId: 'staff-1',
        }),
      },
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    await expect(
      repository.assignComplianceCase('case-1', 'staff-1', 'OPEN', null),
    ).resolves.toBeDefined();
    await expect(
      repository.decideComplianceCase({
        id: 'case-1',
        status: 'CONFIRMED',
        decidedById: 'reviewer-1',
        expectedStatus: 'OPEN',
        expectedAssignedToId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.complianceCase.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it('keeps all decision fields untouched when a confirm/dismiss race loses CAS', async () => {
    const prisma = {
      complianceCase: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'case-1', status: 'CONFIRMED' }),
      },
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);
    const snapshot = {
      id: 'case-1',
      decidedById: 'reviewer-1',
      expectedStatus: 'OPEN' as const,
      expectedAssignedToId: null,
    };

    await expect(
      repository.decideComplianceCase({ ...snapshot, status: 'CONFIRMED' }),
    ).resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(
      repository.decideComplianceCase({ ...snapshot, status: 'DISMISSED' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.complianceCase.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('BackOfficeRepository Finance read contract', () => {
  it('applies exact status/building filters, all four search branches, pagination, payer select, and descending order', async () => {
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([{ id: 'pay-1', amount: 50_000_000 }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    const result = await repository.searchPayments(
      { status: 'APPROVED', buildingId: 'building-1', search: 'Ali' },
      { skip: 20, take: 20 },
    );

    const where = {
      status: 'APPROVED',
      buildingId: 'building-1',
      OR: [
        { reference: { contains: 'Ali', mode: 'insensitive' } },
        { note: { contains: 'Ali', mode: 'insensitive' } },
        {
          payer: {
            OR: [
              { phone: { contains: 'Ali', mode: 'insensitive' } },
              { fullName: { contains: 'Ali', mode: 'insensitive' } },
            ],
          },
        },
      ],
    };
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where,
      select: {
        id: true,
        buildingId: true,
        unitId: true,
        fundId: true,
        amount: true,
        method: true,
        status: true,
        reference: true,
        createdAt: true,
        payer: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(prisma.payment.count).toHaveBeenCalledWith({ where });
    expect(result).toEqual({ items: [{ id: 'pay-1', amount: 50_000_000 }], total: 1 });
  });

  it('freezes detail relations, deterministic refund ordering, and unchanged Rial amounts', async () => {
    const row = {
      id: 'pay-1',
      amount: 50_000_000,
      refunds: [{ id: 'refund-1', amount: 5_000_000 }],
    };
    const prisma = { payment: { findUnique: jest.fn().mockResolvedValue(row) } };
    const repository = new BackOfficeRepository(prisma as unknown as PrismaService);

    await expect(repository.getPaymentAdminDetail('pay-1')).resolves.toBe(row);
    expect(prisma.payment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-1' },
        select: expect.objectContaining({
          building: { select: { id: true, name: true } },
          payer: { select: { id: true, fullName: true, phone: true } },
          amount: true,
          refunds: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, amount: true, reason: true, createdById: true, createdAt: true },
          },
        }),
      }),
    );
    expect(row.amount).toBe(50_000_000);
    expect(row.refunds[0].amount).toBe(5_000_000);
  });
});
