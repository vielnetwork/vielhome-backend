import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ComplianceCaseCategory, FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { parseCasePagination } from '../case-query.util';
import { ListComplianceCasesQueryDto } from './list-compliance-cases-query.dto';

describe('ListComplianceCasesQueryDto', () => {
  const validateQuery = (query: Record<string, unknown>) =>
    validate(plainToInstance(ListComplianceCasesQueryDto, query));

  it.each(Object.values(FraudCaseStatus))('accepts status %s', async (status) => {
    await expect(validateQuery({ status })).resolves.toHaveLength(0);
  });

  it.each(Object.values(ComplianceCaseCategory))('accepts category %s', async (category) => {
    await expect(validateQuery({ category })).resolves.toHaveLength(0);
  });

  it.each(Object.values(VerificationPriority))('accepts priority %s', async (priority) => {
    await expect(validateQuery({ priority })).resolves.toHaveLength(0);
  });

  it.each([
    ['status', 'PENDING'],
    ['category', 'SECURITY'],
    ['priority', 'URGENT'],
  ])('rejects invalid %s %s', async (field, value) => {
    await expect(validateQuery({ [field]: value })).resolves.toHaveLength(1);
  });

  it('accepts optional fields and a complete canonical combination', async () => {
    await expect(validateQuery({})).resolves.toHaveLength(0);
    await expect(
      validateQuery({
        status: FraudCaseStatus.UNDER_INVESTIGATION,
        category: ComplianceCaseCategory.FINANCIAL_ANOMALY,
        priority: VerificationPriority.CRITICAL,
        assignedToId: 'staff-person-id',
        subjectActorId: 'subject-person-id',
        page: '2',
        limit: '100',
      }),
    ).resolves.toHaveLength(0);
  });

  it('preserves pagination defaults, validation, and maximum', () => {
    expect(parseCasePagination(undefined, undefined)).toEqual({ page: 1, limit: 20 });
    expect(parseCasePagination('2', '100')).toEqual({ page: 2, limit: 100 });
    expect(parseCasePagination('1', '101')).toEqual({ page: 1, limit: 100 });
    expect(() => parseCasePagination('0', '20')).toThrow('page must be a positive integer.');
  });
});
