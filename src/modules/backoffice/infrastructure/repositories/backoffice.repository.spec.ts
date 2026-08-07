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
