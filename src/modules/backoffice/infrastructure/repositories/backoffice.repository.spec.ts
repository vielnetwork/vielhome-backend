import { BackOfficeRepository } from './backoffice.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

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
