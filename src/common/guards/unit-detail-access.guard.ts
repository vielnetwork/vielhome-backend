import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BuildingRepository } from '../../modules/building/infrastructure/repositories/building.repository';
import { AuthorizationError } from '../errors/app-error';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Authorization for `GET /buildings/:id/units/:unitId` ONLY (Building
 * Setup Refinement Phase 3, Owner Self-Claim). Deliberately a SEPARATE
 * guard class from `MembershipGuard`, not a modification to it — this
 * codebase's own established precedent for a route that needs slightly
 * different access rules than the shared guard (see `VerifiedRolesGuard`'s
 * doc comment for the same reasoning applied to `RolesGuard`).
 * `MembershipGuard` stays exactly as-is and keeps guarding every other
 * unit-scoped route (ownership transfer, tenancy creation/ending,
 * settings, member lookup, ...) where "any current member, nothing more"
 * remains the correct and only rule — broadening `MembershipGuard` itself
 * would let an invited-but-unclaimed owner take actions far beyond
 * reading their own future unit's detail.
 *
 * This one route needs exactly one additional caller: the exact
 * phone-matched invited-but-not-yet-claimed future owner. Self-claim's
 * whole precondition is reading `canClaimOwnership` on the unit response
 * BEFORE claiming (`BuildingService.getUnitForPerson` /
 * `POST .../claim-ownership`) — that's unreachable if the invited owner
 * can never fetch the unit in the first place.
 *
 * Access is granted when EITHER:
 *  - the caller has a current Membership on the building (existing rule,
 *    delegated to `BuildingRepository.hasMembership`, identical to what
 *    `MembershipGuard` checks), OR
 *  - the caller is the exact invited owner of `:unitId` specifically —
 *    server-verified `Person.phone` matches `Unit.ownerPhone`, and the
 *    unit has no current Ownership yet
 *    (`BuildingRepository.isInvitedOwnerForUnit`, the identical
 *    eligibility test `OwnershipClaimPolicy`/`canClaimOwnership` already
 *    use) — so this guard can never grant read access to any unit the
 *    caller isn't already eligible to self-claim.
 *
 * Never grants access based on anything the client supplies (no request
 * body, no query param) — only the caller's own JWT-derived personId and
 * the unit's already-stored `ownerPhone`. Units remain NOT publicly
 * readable: a stranger whose phone doesn't match a pending invite still
 * gets `AuthorizationError` here, same as before.
 */
@Injectable()
export class UnitDetailAccessGuard implements CanActivate {
  constructor(private readonly buildings: BuildingRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload;
    const buildingId = req.params.id as string;
    const unitId = req.params.unitId as string;

    const isMember = await this.buildings.hasMembership(user.sub, buildingId);
    if (isMember) return true;

    const isInvitedOwner = await this.buildings.isInvitedOwnerForUnit(
      buildingId,
      unitId,
      user.sub,
    );
    if (isInvitedOwner) return true;

    throw new AuthorizationError('You do not have access to this unit.');
  }
}
