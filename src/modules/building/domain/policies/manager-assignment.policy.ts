import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, ConflictError } from '../../../../common/errors/app-error';

export interface ActiveManagerMembership {
  id: string;
  personId: string;
  managerState: string | null;
}

/**
 * Business rules for Manager Assignment (21_ADRs > ADR-022, reconciled
 * from 10.07.04_Manager_Assignment_v1.0 > Rule 001 "Only One Active
 * Manager Per Building" and Rule 007 "Manager Must Be Active Building
 * Member"). Never touches persistence (11_Backend_Architecture > Domain
 * Layer) — only asserts.
 */
@Injectable()
export class ManagerAssignmentPolicy {
  /**
   * A person must already be a member of the building (any role) before
   * they can be handed management — you cannot appoint a total stranger.
   */
  assertCandidateIsMember(isMember: boolean): void {
    if (!isMember) {
      throw new BusinessRuleViolationError(
        'A person must already be a member of this building before they can be assigned as manager.',
      );
    }
  }

  /**
   * A manager cannot be handed off to themselves — that's not a
   * succession, it's a no-op that would still burn an audit/history row.
   */
  assertNotSelfHandoff(currentManagerPersonId: string | undefined, newManagerPersonId: string): void {
    if (currentManagerPersonId && currentManagerPersonId === newManagerPersonId) {
      throw new BusinessRuleViolationError('This person is already the active manager.');
    }
  }

  /**
   * Used where a NEW manager assignment must not silently replace an
   * existing one (e.g. approving a MANAGER-role MembershipRequest) — as
   * opposed to `BuildingService.changeManager`, which is an explicit,
   * intentional handoff and performs its own end-current/start-new
   * transaction instead of calling this.
   */
  assertNoActiveManager(existing: ActiveManagerMembership | null): void {
    if (existing) {
      throw new ConflictError(
        'This building already has an active manager. End the current management before assigning a new one.',
        { currentManagerMembershipId: existing.id },
      );
    }
  }

  /** Only a PROVISIONAL manager can be verified — nothing else is waiting on this step. */
  assertProvisional(managerState: string | null | undefined): void {
    if (managerState !== 'PROVISIONAL') {
      throw new BusinessRuleViolationError(
        'Only a provisional manager can be verified.',
      );
    }
  }

  assertHasActiveManager(existing: ActiveManagerMembership | null): asserts existing is ActiveManagerMembership {
    if (!existing) {
      throw new BusinessRuleViolationError('This building does not currently have an active manager.');
    }
  }
}
