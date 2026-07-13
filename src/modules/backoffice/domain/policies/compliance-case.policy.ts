import { Injectable } from '@nestjs/common';
import type { FraudCaseStatus } from '@prisma/client';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

const OPEN_STATUSES: FraudCaseStatus[] = ['OPEN', 'UNDER_INVESTIGATION'];

/**
 * Pure business rules for Compliance Cases (07.06_Audit_And_Compliance_
 * Center_v1.0 Rule 011/012 — see 21_ADRs > ADR-034). `ComplianceCase.status`
 * reuses `FraudCaseStatus` (see the schema section's header comment), so
 * this policy deliberately mirrors `FraudCasePolicy.assertInvestigable`.
 * No reopen flow is included — unlike Fraud & Abuse's own Rule 016, no
 * 07.06 rule describes reopening a decided Compliance Case.
 */
@Injectable()
export class ComplianceCasePolicy {
  /** A case can only be assigned/decided while OPEN or UNDER_INVESTIGATION — CONFIRMED/DISMISSED are terminal. */
  assertInvestigable(status: FraudCaseStatus): void {
    if (!OPEN_STATUSES.includes(status)) {
      throw new BusinessRuleViolationError(`Compliance case is already decided (status: ${status}).`);
    }
  }
}
