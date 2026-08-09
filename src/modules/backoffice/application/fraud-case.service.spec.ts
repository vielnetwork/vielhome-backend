import { FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { FraudCaseService } from './fraud-case.service';

describe('FraudCaseService list filters', () => {
  it('passes canonical filters and pagination to the repository', async () => {
    const listFraudCases = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const service = new FraudCaseService(
      { listFraudCases } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.listCases(
        {
          status: FraudCaseStatus.CONFIRMED,
          priority: VerificationPriority.CRITICAL,
          assignedToId: 'person-id',
        },
        { page: 2, limit: 20 },
      ),
    ).resolves.toEqual({ items: [], meta: { page: 2, limit: 20, total: 0, totalPages: 1 } });
    expect(listFraudCases).toHaveBeenCalledWith(
      {
        status: FraudCaseStatus.CONFIRMED,
        priority: VerificationPriority.CRITICAL,
        assignedToId: 'person-id',
      },
      { skip: 20, take: 20 },
    );
  });
});
