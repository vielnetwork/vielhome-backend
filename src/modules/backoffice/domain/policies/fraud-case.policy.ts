import { Injectable } from '@nestjs/common';
import type {
  EnforcementActionType,
  EnforcementAppealStatus,
  FraudCaseStatus,
  PlatformStaffRole,
} from '@prisma/client';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

const OPEN_STATUSES: FraudCaseStatus[] = ['OPEN', 'UNDER_INVESTIGATION'];
const TERMINAL_STATUSES: FraudCaseStatus[] = ['CONFIRMED', 'DISMISSED'];

// 21_ADRs > ADR-044 — the one enforcement action type that needs a
// stricter gate than the uniform SENIOR_REVIEWER+ every route in
// `FraudCaseController` already requires. A `Set` (not the
// rank-comparison table `PlatformRolesGuard` uses) since this isn't a
// "at least this rank" check — it's "this ONE severe action type needs
// the TOP role specifically," an orthogonal axis to rank ordering.
const ADMIN_ONLY_ACTION_TYPES = new Set<EnforcementActionType>(['ACCOUNT_SUSPENSION']);

/**
 * Pure business rules for the Fraud & Abuse Center (07.03_Fraud_And_Abuse
 * _Center_v1.0 — see 21_ADRs > ADR-031). No persistence access, fully
 * unit-testable.
 */
@Injectable()
export class FraudCasePolicy {
  /** 07.03 Rule 007/010: a case can only be investigated/decided while OPEN or UNDER_INVESTIGATION — CONFIRMED/DISMISSED are terminal until explicitly reopened (Rule 016). */
  assertInvestigable(status: FraudCaseStatus): void {
    if (!OPEN_STATUSES.includes(status)) {
      throw new BusinessRuleViolationError(`Case is already decided (status: ${status}).`);
    }
  }

  /** 07.03 Rule 016: only a terminal (CONFIRMED/DISMISSED) case may be reopened. */
  assertCanReopen(status: FraudCaseStatus): void {
    if (!TERMINAL_STATUSES.includes(status)) {
      throw new BusinessRuleViolationError(
        'Only a decided case (CONFIRMED or DISMISSED) may be reopened.',
      );
    }
  }

  /**
   * 07.03 Rule 019: an Enforcement Action may be appealed. This MVP allows
   * exactly one appeal per action (`appealStatus` starts NONE, moves to
   * PENDING once, then to a terminal UPHELD/OVERTURNED) rather than an
   * unbounded chain — see ADR-031 Decision for why a repeat-appeal flow
   * isn't built without a source rule describing one.
   */
  assertCanAppealEnforcement(
    appealStatus: EnforcementAppealStatus,
    targetPersonId: string | null,
    callerPersonId: string,
  ): void {
    if (appealStatus !== 'NONE') {
      throw new BusinessRuleViolationError(
        `This enforcement action already has an appeal (status: ${appealStatus}).`,
      );
    }
    if (targetPersonId !== callerPersonId) {
      throw new AuthorizationError(
        'Only the person an enforcement action was issued against may appeal it.',
      );
    }
  }

  /** An appeal can only be decided once, while it is PENDING. */
  assertAppealDecidable(appealStatus: EnforcementAppealStatus): void {
    if (appealStatus !== 'PENDING') {
      throw new BusinessRuleViolationError(`Appeal is not pending (status: ${appealStatus}).`);
    }
  }

  /**
   * 21_ADRs > ADR-044 — `FraudCaseController`'s own `:caseId/enforce` route
   * is gated at `SENIOR_REVIEWER`+ uniformly (07.03 Rule 013/014 names no
   * per-type actor), the same rank ADR-031 originally chose for every
   * enforcement action regardless of severity. ADR-043 made
   * `ACCOUNT_SUSPENSION` a real, immediate lockout for the first time
   * (previously the flag it set did nothing) — the exact trigger ADR-031's
   * own Future Review named for revisiting this ("once a second route ...
   * needs the same pattern" no longer applied once ACCOUNT_SUSPENSION's
   * consequence became real). `WARNING`/`TEMPORARY_RESTRICTION`/
   * `VERIFICATION_REVOCATION` are unaffected — still SENIOR_REVIEWER+,
   * same as every other route in this controller.
   */
  assertCanIssueEnforcement(type: EnforcementActionType, staffRole: PlatformStaffRole): void {
    if (ADMIN_ONLY_ACTION_TYPES.has(type) && staffRole !== 'PLATFORM_ADMIN') {
      throw new AuthorizationError(
        `Issuing a(n) ${type} enforcement action requires PLATFORM_ADMIN.`,
      );
    }
  }
}
