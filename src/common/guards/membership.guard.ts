import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BuildingRepository } from '../../modules/building/infrastructure/repositories/building.repository';
import { AuthorizationError } from '../errors/app-error';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Enforces 05_Business_Rules > Security Rules ("every important action
 * requires authorization") for building-scoped routes.
 *
 * `JwtAuthGuard` only proves *who* is calling — `JwtStrategy`'s own doc
 * comment is explicit that "permission checks happen inside each
 * feature's application/domain layer." This guard is that check for
 * anything shaped `/buildings/:id/...`: it confirms the caller has a
 * current Membership on the `:id` building in the URL, not just a valid
 * token.
 *
 * Apply per-route (method-level `@UseGuards(MembershipGuard)`), AFTER the
 * controller-level `JwtAuthGuard` — never at the controller level, since
 * some routes must stay reachable by non-members on purpose:
 *   - `POST /buildings/setup/*` — scoped by personId, no :id in the URL
 *   - `GET /buildings` — already filtered to the caller's own memberships
 *   - `GET /buildings/lookup` — the postal-code duplicate check itself
 *   - `POST /buildings/:id/membership-requests` — a non-member requesting
 *     to join is exactly the point of this endpoint
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(private readonly buildings: BuildingRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload;
    const buildingId = req.params.id as string;

    const isMember = await this.buildings.hasMembership(user.sub, buildingId);
    if (!isMember) {
      throw new AuthorizationError('You do not have access to this building.');
    }
    return true;
  }
}
