import { Injectable } from '@nestjs/common';
import type { ManagerVerificationStatus } from '@prisma/client';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

/**
 * Pure business rules for the Manager Verification Queue (07.02 /
 * 06.03_Manager_Verification_Flow — see 21_ADRs > ADR-029). No persistence
 * access, fully unit-testable.
 */
@Injectable()
export class ManagerVerificationPolicy {
  /**
   * 06.03 Rule 002 ("30 Percent Owner Approval Can Verify Manager") —
   * integer cross-multiplication, no floating point, same convention as
   * Governance's quorum calculation (ADR-024 Decision point 5).
   * `totalOwners = 0` never meets any threshold (nothing to divide by).
   */
  meetsApprovalThreshold(
    approverCount: number,
    totalOwners: number,
    requiredPercent: number,
  ): boolean {
    if (totalOwners <= 0) return false;
    return approverCount * 100 >= totalOwners * requiredPercent;
  }

  /** Whole-percent progress for display (`Math.floor`, never rounds up past what's actually been achieved). */
  computeApprovalPercent(approverCount: number, totalOwners: number): number {
    if (totalOwners <= 0) return 0;
    return Math.floor((approverCount * 100) / totalOwners);
  }

  assertCaseOpen(status: ManagerVerificationStatus): void {
    if (status !== 'PENDING') {
      throw new BusinessRuleViolationError(`Case is already decided (status: ${status}).`);
    }
  }

  /** The candidate manager cannot approve their own verification — same "can't rule on your own case" pattern as Governance's `assertNotVotingOnOwnCandidacy` (ADR-024) and Cases' `isAgainstManager` self-assignment guard (ADR-025). */
  assertNotSelfApproving(candidateId: string, callerPersonId: string): void {
    if (candidateId === callerPersonId) {
      throw new AuthorizationError('A candidate manager cannot approve their own verification.');
    }
  }

  /** 07.02 Rule 012: only the rejected candidate may appeal. */
  assertCanAppeal(
    status: ManagerVerificationStatus,
    callerPersonId: string,
    candidateId: string,
  ): void {
    if (status !== 'REJECTED') {
      throw new BusinessRuleViolationError('Only a rejected manager verification may be appealed.');
    }
    if (callerPersonId !== candidateId) {
      throw new AuthorizationError('Only the rejected candidate may submit an appeal.');
    }
  }

  /**
   * 07_BackOffice_v2.0's own "BackOffice may: Approve, Reject, Suspend,
   * Restore" — Restore only ever applies to a currently-SUSPENDED case
   * (21_ADRs > ADR-040). Unlike `assertCanAppeal`, there is no
   * caller-identity check here — Restore is a direct platform-staff
   * decision (same actor set as `decide`), not a self-service action by
   * the candidate.
   */
  assertCanRestore(status: ManagerVerificationStatus): void {
    if (status !== 'SUSPENDED') {
      throw new BusinessRuleViolationError(
        `Only a suspended manager verification can be restored (status: ${status}).`,
      );
    }
  }
}
