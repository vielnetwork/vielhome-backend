import { ComplianceCaseCategory, FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { ComplianceCaseService } from './compliance-case.service';

describe('ComplianceCaseService list filters', () => {
  it('passes canonical filters and pagination to the repository without casts', async () => {
    const listComplianceCases = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const service = new ComplianceCaseService(
      { listComplianceCases } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.listCases(
        {
          status: FraudCaseStatus.CONFIRMED,
          category: ComplianceCaseCategory.REPEATED_FRAUD,
          priority: VerificationPriority.CRITICAL,
          assignedToId: 'staff-person-id',
          subjectActorId: 'subject-person-id',
        },
        { page: 2, limit: 20 },
      ),
    ).resolves.toEqual({ items: [], meta: { page: 2, limit: 20, total: 0, totalPages: 1 } });

    expect(listComplianceCases).toHaveBeenCalledWith(
      {
        status: FraudCaseStatus.CONFIRMED,
        category: ComplianceCaseCategory.REPEATED_FRAUD,
        priority: VerificationPriority.CRITICAL,
        assignedToId: 'staff-person-id',
        subjectActorId: 'subject-person-id',
      },
      { skip: 20, take: 20 },
    );
  });
});
