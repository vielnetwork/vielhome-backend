import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { parsePagination } from '../../../../common/pagination/pagination.util';
import { ListFraudCasesQueryDto } from './list-fraud-cases-query.dto';

describe('ListFraudCasesQueryDto', () => {
  const validateQuery = (query: Record<string, unknown>) =>
    validate(plainToInstance(ListFraudCasesQueryDto, query));

  it.each(Object.values(FraudCaseStatus))('accepts status %s', async (status) => {
    await expect(validateQuery({ status })).resolves.toHaveLength(0);
  });
  it.each(Object.values(VerificationPriority))('accepts priority %s', async (priority) => {
    await expect(validateQuery({ priority })).resolves.toHaveLength(0);
  });
  it.each([
    ['status', 'PENDING'],
    ['priority', 'URGENT'],
  ])('rejects invalid %s %s', async (field, value) => {
    await expect(validateQuery({ [field]: value })).resolves.toHaveLength(1);
  });
  it('accepts optional filters and a complete valid combination', async () => {
    await expect(validateQuery({})).resolves.toHaveLength(0);
    await expect(
      validateQuery({
        status: FraudCaseStatus.UNDER_INVESTIGATION,
        priority: VerificationPriority.CRITICAL,
        assignedToId: 'person-id',
        page: '2',
        limit: '100',
      }),
    ).resolves.toHaveLength(0);
  });

  it('preserves the tolerant pagination defaults and maximum', () => {
    expect(parsePagination(undefined, undefined)).toEqual({ page: 1, limit: 20 });
    expect(parsePagination('2', '100')).toEqual({ page: 2, limit: 100 });
    expect(parsePagination('0', '101')).toEqual({ page: 1, limit: 100 });
    expect(parsePagination('invalid', 'invalid')).toEqual({ page: 1, limit: 20 });
  });
});
