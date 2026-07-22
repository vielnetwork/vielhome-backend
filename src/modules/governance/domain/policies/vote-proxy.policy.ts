import { Injectable } from '@nestjs/common';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

export interface CurrentVoteProxy {
  id: string;
  granterPersonId: string;
}

/**
 * Business rules for Standing Proxy Voting (08.07 Rule 011/012 — see
 * 21_ADRs > ADR-089). Never touches persistence (11_Backend_Architecture
 * > Domain Layer) — only asserts.
 */
@Injectable()
export class VoteProxyPolicy {
  /**
   * Only the unit's own LIVE eligible voter right now (owner, or tenant
   * if the building's `allowTenantVoting` toggle is on and the unit
   * qualifies) may appoint a proxy for that unit — the same self-service
   * -only posture `OwnershipTransferPolicy`/`TenancyPolicy` already use
   * for unit-scoped rights (a manager cannot appoint a proxy on a unit's
   * behalf).
   */
  assertCallerIsEligibleVoter(isEligibleVoter: boolean): void {
    if (!isEligibleVoter) {
      throw new AuthorizationError("Only this unit's current eligible voter may appoint a proxy.");
    }
  }

  /** A standing proxy is a delegation to someone else — appointing yourself is not a proxy. */
  assertNotSelfProxy(granterPersonId: string, proxyPersonId: string): void {
    if (granterPersonId === proxyPersonId) {
      throw new BusinessRuleViolationError('You cannot appoint yourself as your own proxy.');
    }
  }

  /**
   * No source rule names this explicitly, but a proxy who is not even a
   * current member of the building could never reach the routes needed
   * to cast the ballot they were appointed to cast — appointing one
   * would be a dead-end delegation, not a real fast-follow.
   */
  assertProxyIsMember(isMember: boolean): void {
    if (!isMember) {
      throw new BusinessRuleViolationError('A proxy must be a current member of this building.');
    }
  }

  /** Revocation is self-service only — same posture as appointment; see `VoteProxyService.revoke`'s own comment on why a manager can't call this. */
  assertCallerIsGranter(isGranter: boolean): void {
    if (!isGranter) {
      throw new AuthorizationError('Only the person who granted a proxy may revoke it.');
    }
  }

  /**
   * Same TypeScript `asserts` narrowing pattern
   * `ManagerAssignmentPolicy.assertHasActiveManager` already established
   * — lets `VoteProxyService.revoke` use the checked-non-null value
   * afterward without a manual `!` assertion.
   */
  assertHasCurrentProxy(existing: CurrentVoteProxy | null): asserts existing is CurrentVoteProxy {
    if (!existing) {
      throw new BusinessRuleViolationError('This unit has no current proxy to revoke.');
    }
  }
}
