import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

export interface CaseAccessInput {
  visibility: string;
  createdById: string;
  assigneeId: string | null;
}

/**
 * Business rules for Cases/Requests (06.07_Request_And_Complaint_Flow,
 * 08.08_Request_And_Complaint_API — see 21_ADRs > ADR-025). Never touches
 * persistence (11_Backend_Architecture > Domain Layer) — only asserts.
 * "Privileged" throughout means MANAGER/BOARD_MEMBER/ACCOUNTANT — the
 * roles 08.08 Rule 008 allows a case to be assigned to.
 */
@Injectable()
export class CasePolicy {
  /** 06.07 Rule 021: the creator always sees their own case regardless of visibility/assignment; privileged roles see everything. */
  assertVisible(input: CaseAccessInput, requesterPersonId: string, isPrivileged: boolean): void {
    if (input.visibility === 'PUBLIC') return;
    if (input.createdById === requesterPersonId) return;
    if (input.assigneeId === requesterPersonId) return;
    if (isPrivileged) return;
    throw new AuthorizationError('You do not have access to this case.');
  }

  /** Only the creator or a privileged role may edit a case's own fields (title/description/priority/visibility), and only while it's not closed. */
  assertEditable(
    createdById: string,
    requesterPersonId: string,
    isPrivileged: boolean,
    status: string,
  ): void {
    if (createdById !== requesterPersonId && !isPrivileged) {
      throw new AuthorizationError(
        'Only the case creator or a privileged role may edit this case.',
      );
    }
    if (status === 'CLOSED') {
      throw new BusinessRuleViolationError(
        'A closed case must be reopened before it can be edited.',
      );
    }
  }

  /** 06.07 Rule 016: internal notes are a privileged-only concept. */
  assertCanPostInternalMessage(isInternal: boolean, isPrivileged: boolean): void {
    if (isInternal && !isPrivileged) {
      throw new AuthorizationError('Only a privileged role may post an internal note.');
    }
  }

  assertNotClosed(status: string): void {
    if (status === 'CLOSED') {
      throw new BusinessRuleViolationError('This case is closed.');
    }
  }

  /** 06.07 Rule 017: a complaint against the manager cannot be routed to the manager. */
  assertAssignable(isAgainstManager: boolean, assigneeHoldsManagerRole: boolean): void {
    if (isAgainstManager && assigneeHoldsManagerRole) {
      throw new BusinessRuleViolationError(
        'A complaint against the manager cannot be assigned to the manager — route it to a board member instead.',
      );
    }
  }

  /** 08.08 Rule 014/015: resolving requires a resolution code; an already-resolved/closed case cannot be resolved again. */
  assertResolvable(status: string): void {
    if (status === 'RESOLVED' || status === 'CLOSED') {
      throw new BusinessRuleViolationError(`This case is already ${status.toLowerCase()}.`);
    }
  }

  assertCloseable(status: string): void {
    if (status === 'CLOSED') {
      throw new BusinessRuleViolationError('This case is already closed.');
    }
  }

  /** 06.07 Rule 014: only a RESOLVED or CLOSED case may be reopened. */
  assertReopenable(status: string): void {
    if (status !== 'RESOLVED' && status !== 'CLOSED') {
      throw new BusinessRuleViolationError('Only a resolved or closed case can be reopened.');
    }
  }
}
