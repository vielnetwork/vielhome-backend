import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';
import { BuildingRepository } from '../../modules/building/infrastructure/repositories/building.repository';
import { AuthorizationError } from '../errors/app-error';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Authorization Layer (21_ADRs > ADR-022, reconciled from
 * 10.07.05_Authorization_Layer_v1.0): resolves the caller's current roles
 * on the `:id` building and checks them against the route's `@Roles(...)`
 * requirement.
 *
 * Deny by default: if the caller has no current Membership on this
 * building at all, or none of their current roles match, access is
 * refused. A route with `@Roles()` but nothing decorated on it (or
 * `RolesGuard` used without `@Roles()`) also denies — there is nothing to
 * satisfy — so always pair this guard with a `@Roles(...)` decorator.
 *
 * Multiple roles held on the same building are unioned per
 * 10.07.05_Authorization_Layer > "Permission Resolution Rule": a person
 * who is both OWNER and BOARD_MEMBER passes a route that requires either.
 *
 * Use this INSTEAD OF `MembershipGuard` (not in addition to) when a route
 * needs a *specific* role rather than "any current member" — role
 * resolution already implies membership (no roles found -> denied).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly buildings: BuildingRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.get<MembershipRole[]>(ROLES_KEY, context.getHandler());
    if (!requiredRoles || requiredRoles.length === 0) {
      return false;
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload;
    const buildingId = req.params.id as string;

    const myRoles = await this.buildings.getRoles(user.sub, buildingId);
    const allowed = myRoles.some((role) => requiredRoles.includes(role));

    if (!allowed) {
      throw new AuthorizationError(
        `This action requires one of the following roles: ${requiredRoles.join(', ')}.`,
      );
    }
    return true;
  }
}
