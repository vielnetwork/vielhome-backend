import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CaseStatus, SupportCaseCategory, VerificationPriority } from '@prisma/client';
import { ListSupportCasesQueryDto } from './list-support-cases-query.dto';

describe('ListSupportCasesQueryDto', () => {
  const validateQuery = (query: Record<string, unknown>) =>
    validate(plainToInstance(ListSupportCasesQueryDto, query));

  it.each(Object.values(CaseStatus))('accepts status %s', async (status) => {
    await expect(validateQuery({ status })).resolves.toHaveLength(0);
  });

  it.each(Object.values(VerificationPriority))('accepts priority %s', async (priority) => {
    await expect(validateQuery({ priority })).resolves.toHaveLength(0);
  });

  it.each(Object.values(SupportCaseCategory))('accepts category %s', async (category) => {
    await expect(validateQuery({ category })).resolves.toHaveLength(0);
  });

  it.each([
    ['status', 'PENDING'],
    ['priority', 'URGENT'],
    ['category', 'ACCOUNT'],
    ['category', 'BUILDING'],
  ])('rejects stale or invalid %s value %s', async (field, value) => {
    await expect(validateQuery({ [field]: value })).resolves.toHaveLength(1);
  });

  it('accepts a complete valid filter and pagination combination', async () => {
    await expect(
      validateQuery({
        status: CaseStatus.IN_PROGRESS,
        priority: VerificationPriority.CRITICAL,
        category: SupportCaseCategory.VERIFICATION,
        assignedToId: 'staff-person-id',
        page: '2',
        limit: '50',
      }),
    ).resolves.toHaveLength(0);
  });

  it('keeps every filter optional', async () => {
    await expect(validateQuery({})).resolves.toHaveLength(0);
  });
});
