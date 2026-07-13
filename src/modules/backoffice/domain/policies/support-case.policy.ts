import { Injectable } from '@nestjs/common';
import type { CaseStatus, VerificationPriority } from '@prisma/client';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

const CLOSED_STATUSES: CaseStatus[] = ['RESOLVED', 'CLOSED'];
const PRIORITY_ORDER: VerificationPriority[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

/**
 * Pure business rules for the Support & Operations Center
 * (07.05_Support_And_Operations_Center_v1.0 — see 21_ADRs > ADR-032). No
 * persistence access, fully unit-testable.
 */
@Injectable()
export class SupportCasePolicy {
  /** A ticket may be worked (assigned/messaged/escalated/resolved) unless it's already CLOSED. RESOLVED still allows a reply before closing. */
  assertActionable(status: CaseStatus): void {
    if (status === 'CLOSED') {
      throw new BusinessRuleViolationError('This support case is closed.');
    }
  }

  /** 07.05's implicit lifecycle: only a RESOLVED ticket may be closed — resolving and closing are distinct staff actions. */
  assertResolvedForClose(status: CaseStatus): void {
    if (status !== 'RESOLVED') {
      throw new BusinessRuleViolationError('Only a resolved support case may be closed.');
    }
  }

  /** 07.05 Rule 011 — reopen only makes sense on a RESOLVED or CLOSED ticket. */
  assertCanReopen(status: CaseStatus): void {
    if (!CLOSED_STATUSES.includes(status)) {
      throw new BusinessRuleViolationError('Only a resolved or closed support case may be reopened.');
    }
  }

  /** 07.05 Rule 008 — escalation raises priority by one level; already-CRITICAL has nowhere further to go. */
  nextEscalatedPriority(current: VerificationPriority): VerificationPriority {
    const index = PRIORITY_ORDER.indexOf(current);
    if (index === PRIORITY_ORDER.length - 1) {
      throw new BusinessRuleViolationError('This support case is already at CRITICAL priority.');
    }
    return PRIORITY_ORDER[index + 1];
  }

  /** Only the ticket's own creator (or platform staff, checked separately at the controller level) may view/act on it via the member-facing routes. */
  assertVisibleToNonStaff(createdById: string, callerPersonId: string): void {
    if (createdById !== callerPersonId) {
      throw new AuthorizationError('You do not have access to this support case.');
    }
  }
}
