import { Injectable } from '@nestjs/common';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * Owner Self-Claim (Building Setup Refinement Phase 3). Pure business
 * rules only — no persistence here (11_Backend_Architecture > Domain
 * Layer). The conservative, approved eligibility rule (no cold claim, no
 * client-supplied owner identity):
 *
 *   canClaim = unit has NO current Ownership
 *              AND Unit.ownerPhone (set only via the trusted, MANAGER-only
 *              invite-owner / invite-owner/v2 flow) exactly matches the
 *              authenticated caller's own server-verified Person.phone.
 *
 * Identity authority = the authenticated Person (`req.user.sub` ->
 * server-side `Person.phone` lookup). Eligibility authority = the
 * Unit.ownerPhone match + no-current-Ownership check below. Role labels
 * (OWNER/TENANT/BOARD_MEMBER/ACCOUNTANT/...) are never consulted — a
 * Person already holding another role (even TENANT of this same unit) who
 * is genuinely the invited owner by phone is still eligible; a Person
 * without a matching phone is never eligible regardless of role.
 */
@Injectable()
export class OwnershipClaimPolicy {
  assertEligible(params: {
    hasCurrentOwnership: boolean;
    unitOwnerPhone: string | null;
    callerPhone: string;
  }): void {
    if (params.hasCurrentOwnership) {
      throw new BusinessRuleViolationError('This unit already has a registered owner.');
    }
    if (!params.unitOwnerPhone || params.unitOwnerPhone !== params.callerPhone) {
      throw new AuthorizationError(
        'You are not the invited owner of this unit. Ask the building manager to register your phone number as this unit’s owner first.',
      );
    }
  }
}
