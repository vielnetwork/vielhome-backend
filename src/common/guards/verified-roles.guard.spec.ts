import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { VerifiedRolesGuard } from './verified-roles.guard';
import { AuthorizationError } from '../errors/app-error';

function makeContext(params: Record<string, string>, user: { sub: string }): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () => ({ params, user }),
    }),
  } as unknown as ExecutionContext;
}

describe('VerifiedRolesGuard', () => {
  it('denies when no @Roles() metadata is present on the route', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const buildings = { getVerifiedRoles: jest.fn() } as never;
    const guard = new VerifiedRolesGuard(reflector, buildings);

    await expect(
      guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' })),
    ).resolves.toBe(false);
    expect((buildings as { getVerifiedRoles: jest.Mock }).getVerifiedRoles).not.toHaveBeenCalled();
  });

  it('allows when the caller holds a required role and it counts as verified (e.g. BOARD_MEMBER, or a VERIFIED MANAGER already filtered in upstream)', async () => {
    const reflector = { get: jest.fn().mockReturnValue(['MANAGER', 'BOARD_MEMBER']) } as unknown as Reflector;
    const buildings = { getVerifiedRoles: jest.fn().mockResolvedValue(['OWNER', 'BOARD_MEMBER']) } as never;
    const guard = new VerifiedRolesGuard(reflector, buildings);

    await expect(
      guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' })),
    ).resolves.toBe(true);
  });

  it('denies a PROVISIONAL or SUSPENDED manager — repository already excluded the unverified MANAGER row, so it never appears in the resolved role list', async () => {
    const reflector = { get: jest.fn().mockReturnValue(['MANAGER']) } as unknown as Reflector;
    // BuildingRepository.getVerifiedRoles filters out MANAGER rows unless
    // managerState === 'VERIFIED' — a PROVISIONAL/SUSPENDED manager's role
    // list arrives here with MANAGER already stripped out.
    const buildings = { getVerifiedRoles: jest.fn().mockResolvedValue([]) } as never;
    const guard = new VerifiedRolesGuard(reflector, buildings);

    await expect(
      guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('denies when the caller holds none of the required roles', async () => {
    const reflector = { get: jest.fn().mockReturnValue(['MANAGER']) } as unknown as Reflector;
    const buildings = { getVerifiedRoles: jest.fn().mockResolvedValue(['TENANT']) } as never;
    const guard = new VerifiedRolesGuard(reflector, buildings);

    await expect(
      guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('allows a VERIFIED manager (role present in the resolved list)', async () => {
    const reflector = { get: jest.fn().mockReturnValue(['MANAGER', 'BOARD_MEMBER']) } as unknown as Reflector;
    const buildings = { getVerifiedRoles: jest.fn().mockResolvedValue(['MANAGER']) } as never;
    const guard = new VerifiedRolesGuard(reflector, buildings);

    await expect(
      guard.canActivate(makeContext({ id: 'b1' }, { sub: 'p1' })),
    ).resolves.toBe(true);
  });
});
