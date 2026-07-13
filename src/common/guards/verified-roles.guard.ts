import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';
import { BuildingRepository } from '../../modules/building/infrastructure/repositories/building.repository';
import { AuthorizationError } from '../errors/app-error';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Verified-manager-aware `@Roles(...)` guard (21_ADRs > ADR-038, closing a
 * gap `RolesGuard`'s own doc comment has carried since ADR-022 and that
 * ADR-024/ADR-029 each independently flagged again: "checks the MANAGER
 * role only, not managerState"). Identical to `RolesGuard` in every way
 * except the role list it resolves — see `BuildingRepository
 * .getVerifiedRoles`'s doc comment for exactly which manager lifecycle
 * states count.
 *
 * Deliberately a SEPARATE guard class, not a modification to `RolesGuard`
 * itself, and deliberately NOT a blanket swap across every `@Roles
 * ('MANAGER')` route in the codebase. Only Governance's vote
 * create/publish/close/cancel routes use this guard (06.06 Rule 001 /
 * 08.07 Rule 001 — "Only Authorized Governance Roles Can Create Votes":
 * Verified Manager or Board Member — and 06.03 Rule 006, which this
 * codebase's own `ManagerVerificationService.decideCase` doc comment has
 * already read as scoping the SUSPENDED block to "governance features"
 * specifically). Finance, Cases, Documents, and Building's own
 * manager-handoff routes keep using plain `RolesGuard` — no source
 * document makes the same "must be Verified" claim for those domains, and
 * inventing one here would be exactly the kind of unsupported rule this
 * project's ADR series has consistently declined to add. See ADR-038
 * Future Review for the disclosed, not-yet-decided question of whether
 * Finance should eventually get the same treatment.
 */
@Injectable()
export class VerifiedRolesGuard implements CanActivate {
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

    const myRoles = await this.buildings.getVerifiedRoles(user.sub, buildingId);
    const allowed = myRoles.some((role) => requiredRoles.includes(role));

    if (!allowed) {
      throw new AuthorizationError(
        `This action requires one of the following roles (manager must be verified): ${requiredRoles.join(', ')}.`,
      );
    }
    return true;
  }
}
