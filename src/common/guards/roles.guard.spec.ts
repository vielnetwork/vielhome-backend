import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AuthorizationError } from '../errors/app-error';

function makeContext(params: Record<string, string>, user: { sub: string }): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () => ({ params, user }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('denies when no @Roles() metadata is present on the route', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const buildings = { getRoles: jest.fn() } as never;
    const guard = new RolesGuard(reflector, buildings);

    await expect(guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' }))).resolves.toBe(false);
    expect((buildings as { getRoles: jest.Mock }).getRoles).not.toHaveBeenCalled();
  });

  it('allows when the caller holds one of the required roles', async () => {
    const reflector = {
      get: jest.fn().mockReturnValue(['MANAGER', 'ACCOUNTANT']),
    } as unknown as Reflector;
    const buildings = { getRoles: jest.fn().mockResolvedValue(['OWNER', 'MANAGER']) } as never;
    const guard = new RolesGuard(reflector, buildings);

    await expect(guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' }))).resolves.toBe(true);
  });

  it('denies when the caller holds none of the required roles', async () => {
    const reflector = { get: jest.fn().mockReturnValue(['MANAGER']) } as unknown as Reflector;
    const buildings = { getRoles: jest.fn().mockResolvedValue(['TENANT']) } as never;
    const guard = new RolesGuard(reflector, buildings);

    await expect(guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' }))).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('denies a non-member outright (no roles at all)', async () => {
    const reflector = { get: jest.fn().mockReturnValue(['MANAGER']) } as unknown as Reflector;
    const buildings = { getRoles: jest.fn().mockResolvedValue([]) } as never;
    const guard = new RolesGuard(reflector, buildings);

    await expect(guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' }))).rejects.toThrow(
      AuthorizationError,
    );
  });
});
