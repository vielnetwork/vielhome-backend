import type { ExecutionContext } from '@nestjs/common';
import { BuildingRepository } from '../../modules/building/infrastructure/repositories/building.repository';
import { FinanceMembershipGuard, MembershipGuard } from './membership.guard';

it('blocks accountant-only membership on general routes and keeps existing finance access building-scoped', async () => {
  const count = jest.fn(async ({ where }) =>
    where.personId === 'accountant' && where.buildingId === 'building-a' &&
    where.isCurrent && !where.role ? 1 : 0,
  );
  const repository = new BuildingRepository({ membership: { count } } as never);
  const context = (id: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'accountant' }, params: { id } }) }),
  }) as ExecutionContext;

  await expect(new MembershipGuard(repository).canActivate(context('building-a'))).rejects.toThrow();
  await expect(new FinanceMembershipGuard(repository).canActivate(context('building-a'))).resolves.toBe(true);
  await expect(new FinanceMembershipGuard(repository).canActivate(context('building-b'))).rejects.toThrow();
  expect(count).toHaveBeenCalledWith({
    where: { personId: 'accountant', buildingId: 'building-a', isCurrent: true, role: { not: 'ACCOUNTANT' } },
  });
});
