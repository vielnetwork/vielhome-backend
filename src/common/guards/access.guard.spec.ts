import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessGuard } from './access.guard';
import { AuthorizationError, NotImplementedAppError } from '../errors/app-error';

function makeContext(user: { sub: string }): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('AccessGuard', () => {
  it('denies when no @RequiresAccess() metadata is present on the route', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const backOffice = { isPersonBackofficeApproved: jest.fn() } as never;
    const guard = new AccessGuard(reflector, backOffice);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(false);
    expect(
      (backOffice as { isPersonBackofficeApproved: jest.Mock }).isPersonBackofficeApproved,
    ).not.toHaveBeenCalled();
  });

  it('FREE always passes for an authenticated caller, no DB lookup', async () => {
    const reflector = { get: jest.fn().mockReturnValue('FREE') } as unknown as Reflector;
    const backOffice = { isPersonBackofficeApproved: jest.fn() } as never;
    const guard = new AccessGuard(reflector, backOffice);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(true);
    expect(
      (backOffice as { isPersonBackofficeApproved: jest.Mock }).isPersonBackofficeApproved,
    ).not.toHaveBeenCalled();
  });

  it('BACKOFFICE_APPROVED passes when Person.isBackofficeApproved is true', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue('BACKOFFICE_APPROVED'),
    } as unknown as Reflector;
    const backOffice = { isPersonBackofficeApproved: jest.fn().mockResolvedValue(true) } as never;
    const guard = new AccessGuard(reflector, backOffice);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(true);
  });

  it('BACKOFFICE_APPROVED throws AuthorizationError with details.requiredAccess when unapproved', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue('BACKOFFICE_APPROVED'),
    } as unknown as Reflector;
    const backOffice = { isPersonBackofficeApproved: jest.fn().mockResolvedValue(false) } as never;
    const guard = new AccessGuard(reflector, backOffice);

    let caught: unknown;
    try {
      await guard.canActivate(makeContext({ sub: 'p1' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).httpStatus).toBe(403);
    expect((caught as AuthorizationError).details).toEqual({
      requiredAccess: 'BACKOFFICE_APPROVED',
    });
  });

  it('PRO fails closed with a stable, controlled NotImplementedAppError — never a silent pass', async () => {
    const reflector = { get: jest.fn().mockReturnValue('PRO') } as unknown as Reflector;
    const backOffice = { isPersonBackofficeApproved: jest.fn() } as never;
    const guard = new AccessGuard(reflector, backOffice);

    let caught: unknown;
    try {
      await guard.canActivate(makeContext({ sub: 'p1' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotImplementedAppError);
    expect((caught as NotImplementedAppError).httpStatus).toBe(501);
    expect((caught as NotImplementedAppError).details).toEqual({ accessLevel: 'PRO' });
    expect(
      (backOffice as { isPersonBackofficeApproved: jest.Mock }).isPersonBackofficeApproved,
    ).not.toHaveBeenCalled();
  });
});
