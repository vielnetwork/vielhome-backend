import { Injectable } from '@nestjs/common';
import { AuthorizationError } from '../../../../common/errors/app-error';

/**
 * Pure business rules for Ownership Transfer (10.07.02_Ownership_v1.0 —
 * see 21_ADRs > ADR-035). `10.07.01_Manager_User_Flow` is explicit that a
 * manager "cannot change legal ownership directly," so this is gated to
 * the unit's own current owner (self-service) — not a building-wide
 * `RolesGuard` role check, which can't tell "an owner of this building"
 * apart from "the owner of THIS unit."
 */
@Injectable()
export class OwnershipTransferPolicy {
  assertCallerIsCurrentOwner(isCurrentOwner: boolean): void {
    if (!isCurrentOwner) {
      throw new AuthorizationError(
        "Only the unit's current owner may initiate an ownership transfer.",
      );
    }
  }
}
