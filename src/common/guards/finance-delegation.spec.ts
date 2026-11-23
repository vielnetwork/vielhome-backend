import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AllowAccountantDelegation, RolesGuard } from './roles.guard';
import { Roles } from '../decorators/roles.decorator';

class FinanceRoutes {
  @Roles('MANAGER')
  @AllowAccountantDelegation('canIssueCharges')
  issue() {}

  @Roles('MANAGER')
  @AllowAccountantDelegation('canManageFunds')
  manageFunds() {}

  @Roles('MANAGER')
  invite() {}
}

it('requires the exact current grant on the same building and preserves manager-only operations', async () => {
  let granted = true;
  const repository = {
    getRoles: jest.fn().mockResolvedValue(['ACCOUNTANT']),
    hasFinanceDelegation: jest.fn(async (_person, building, permission) =>
      granted && building === 'a' && permission === 'canIssueCharges'),
  };
  const guard = new RolesGuard(new Reflector(), repository as never);
  const at = (method: keyof FinanceRoutes, id = 'a') => ({
    getHandler: () => FinanceRoutes.prototype[method],
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'person' }, params: { id } }) }),
  }) as unknown as ExecutionContext;
  await expect(guard.canActivate(at('issue'))).resolves.toBe(true);
  await expect(guard.canActivate(at('issue', 'b'))).rejects.toThrow();
  await expect(guard.canActivate(at('manageFunds'))).rejects.toThrow();
  await expect(guard.canActivate(at('invite'))).rejects.toThrow();
  granted = false;
  await expect(guard.canActivate(at('issue'))).rejects.toThrow();
});
