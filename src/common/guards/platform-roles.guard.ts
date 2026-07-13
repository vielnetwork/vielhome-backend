import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformStaffRole } from '@prisma/client';
import { BackOfficeRepository } from '../../modules/backoffice/infrastructure/repositories/backoffice.repository';
import { AuthorizationError } from '../errors/app-error';
import { PLATFORM_ROLES_KEY } from '../decorators/platform-roles.decorator';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/** REVIEWER < SENIOR_REVIEWER < PLATFORM_ADMIN — unlike `RolesGuard`'s flat OR (building roles are independent, not ranked), platform staff roles ARE hierarchical: a route requiring `@PlatformRoles('REVIEWER')` is satisfied by any of the three, `@PlatformRoles('SENIOR_REVIEWER')` by SENIOR_REVIEWER or PLATFORM_ADMIN only, `@PlatformRoles('PLATFORM_ADMIN')` by PLATFORM_ADMIN alone. */
const RANK: Record<PlatformStaffRole, number> = {
  REVIEWER: 1,
  SENIOR_REVIEWER: 2,
  PLATFORM_ADMIN: 3,
};

/**
 * Authorization Layer for BackOffice routes (21_ADRs > ADR-029) — the
 * platform-staff mirror of `RolesGuard`. `RolesGuard` resolves a caller's
 * roles from building-scoped `Membership`; this guard resolves them from
 * the global `PlatformStaff` table instead (a Person can hold both at
 * once, independently — see `PlatformStaff`'s own schema comment).
 *
 * Deny by default: no `PlatformStaff` row, an inactive one
 * (`isActive: false`), or a rank below every required role all refuse
 * access. Always pair with `@PlatformRoles(...)`.
 */
@Injectable()
export class PlatformRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly backOffice: BackOfficeRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.get<PlatformStaffRole[]>(PLATFORM_ROLES_KEY, context.getHandler());
    if (!requiredRoles || requiredRoles.length === 0) {
      return false;
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload;

    const staff = await this.backOffice.getActivePlatformStaff(user.sub);
    if (!staff) {
      throw new AuthorizationError('This action requires platform staff access.');
    }

    const minRequiredRank = Math.min(...requiredRoles.map((r) => RANK[r]));
    if (RANK[staff.role] < minRequiredRank) {
      throw new AuthorizationError(
        `This action requires one of the following platform roles (or higher): ${requiredRoles.join(', ')}.`,
      );
    }
    return true;
  }
}
