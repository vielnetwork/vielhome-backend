import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { AuthorizationError } from '../errors/app-error';

function makeContext(user: { sub: string }): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it('denies when no @RequiresPermission() metadata is present on the route', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const resolver = { resolve: jest.fn() } as never;
    const guard = new PermissionsGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(false);
    expect((resolver as { resolve: jest.Mock }).resolve).not.toHaveBeenCalled();
  });

  it('denies when no @RequiresPermission() metadata is an empty array', async () => {
    const reflector = { get: jest.fn().mockReturnValue([]) } as unknown as Reflector;
    const resolver = { resolve: jest.fn() } as never;
    const guard = new PermissionsGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(false);
  });

  it('allows when the caller holds the single required permission', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue(['MARKETPLACE_APPROVE']),
    } as unknown as Reflector;
    const resolver = {
      resolve: jest.fn().mockResolvedValue(new Set(['MARKETPLACE_REVIEW', 'MARKETPLACE_APPROVE'])),
    } as never;
    const guard = new PermissionsGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(true);
  });

  it('allows when the caller holds at least one of several required permissions (OR semantics)', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue(['FINANCE_VIEW', 'AUDIT_VIEW']),
    } as unknown as Reflector;
    const resolver = { resolve: jest.fn().mockResolvedValue(new Set(['AUDIT_VIEW'])) } as never;
    const guard = new PermissionsGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).resolves.toBe(true);
  });

  it('throws AuthorizationError (403) when the caller holds none of the required permissions', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue(['SYSTEM_SETTINGS']),
    } as unknown as Reflector;
    const resolver = { resolve: jest.fn().mockResolvedValue(new Set(['USER_VIEW'])) } as never;
    const guard = new PermissionsGuard(reflector, resolver);

    let caught: unknown;
    try {
      await guard.canActivate(makeContext({ sub: 'p1' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).httpStatus).toBe(403);
  });

  it('denies (throws) when the caller resolves to an empty permission set (non-staff/deny-by-default)', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue(['USER_VIEW']),
    } as unknown as Reflector;
    const resolver = { resolve: jest.fn().mockResolvedValue(new Set()) } as never;
    const guard = new PermissionsGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ sub: 'p1' }))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
