import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentStatus } from '@prisma/client';
import { parsePagination } from '../../../../common/pagination/pagination.util';
import {
  AdminPaymentsFiltersDto,
  ListAdminPaymentsQueryDto,
} from './list-admin-payments-query.dto';

describe('ListAdminPaymentsQueryDto', () => {
  const errorsFor = (input: Record<string, unknown>) =>
    validate(plainToInstance(ListAdminPaymentsQueryDto, input));

  it('accepts an omitted query and preserves the tolerant pagination defaults', async () => {
    await expect(errorsFor({})).resolves.toHaveLength(0);
    expect(parsePagination(undefined, undefined)).toEqual({ page: 1, limit: 20 });
  });

  it.each(Object.values(PaymentStatus))('accepts canonical status %s', async (status) => {
    await expect(errorsFor({ status })).resolves.toHaveLength(0);
  });

  it('rejects an invalid status before repository execution', async () => {
    const errors = await errorsFor({ status: 'PAID' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('status');
  });

  it('accepts only string filter and pagination query values', async () => {
    await expect(
      errorsFor({ search: 'Ali', buildingId: 'building-1', page: '2', limit: '50' }),
    ).resolves.toHaveLength(0);
    await expect(
      errorsFor({ search: 1, buildingId: false, page: 2, limit: 50 }),
    ).resolves.toHaveLength(4);
  });

  it('freezes malformed pagination fallback and maximum-limit clamping', () => {
    expect(parsePagination('bad', 'bad')).toEqual({ page: 1, limit: 20 });
    expect(parsePagination('0', '-1')).toEqual({ page: 1, limit: 20 });
    expect(parsePagination('2', '101')).toEqual({ page: 2, limit: 100 });
  });

  it('shares validated status/building/search filters with export', async () => {
    const dto = plainToInstance(AdminPaymentsFiltersDto, {
      status: 'APPROVED',
      buildingId: 'building-1',
      search: 'reference',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
