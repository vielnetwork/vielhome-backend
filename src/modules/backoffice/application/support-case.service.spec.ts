import { CaseStatus, SupportCaseCategory, VerificationPriority } from '@prisma/client';
import { SupportCaseService } from './support-case.service';

describe('SupportCaseService list filters', () => {
  it('passes canonical enum filters and translated pagination to the repository', async () => {
    const listSupportCases = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const service = new SupportCaseService(
      { listSupportCases } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.listCases(
        {
          status: CaseStatus.IN_PROGRESS,
          priority: VerificationPriority.CRITICAL,
          category: SupportCaseCategory.VERIFICATION,
          assignedToId: 'staff-person-id',
        },
        { page: 2, limit: 20 },
      ),
    ).resolves.toEqual({
      items: [],
      meta: { page: 2, limit: 20, total: 0, totalPages: 1 },
    });

    expect(listSupportCases).toHaveBeenCalledWith(
      {
        status: CaseStatus.IN_PROGRESS,
        priority: VerificationPriority.CRITICAL,
        category: SupportCaseCategory.VERIFICATION,
        assignedToId: 'staff-person-id',
      },
      { skip: 20, take: 20 },
    );
  });
});
