import { Injectable } from '@nestjs/common';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';

/**
 * Marketplace Access-Gate Implementation Phase. Grants/revokes the single
 * platform-approval fact (`Person.isBackofficeApproved`) that the
 * BACKOFFICE_APPROVED `AccessLevel` reads. Deliberately NOT built on the
 * Fraud & Abuse Center's `EnforcementAction` machinery (`fraud-case.
 * service.ts`) — that system's semantics are punitive/consequential
 * (warnings, suspensions, appeals); this is a positive feature-approval
 * grant with its own, much simpler, always-reversible lifecycle. Route-
 * level authorization (`SENIOR_REVIEWER`+ only, never `REVIEWER`, never
 * any building role) is enforced by `PlatformRolesGuard` on
 * `PersonAccessController` — this service trusts that gate and focuses on
 * the state transition + audit trail.
 */
@Injectable()
export class PersonAccessService {
  constructor(private readonly backOffice: BackOfficeRepository) {}

  /**
   * Single entry point for both directions (`false -> true` and
   * `true -> false` — requirement 1: "do not create a grant-only
   * workflow"). The repository accepts only a real false↔true transition;
   * same-state repeats and concurrent losers return a stable conflict.
   */
  async setBackofficeApproval(
    targetPersonId: string,
    approved: boolean,
    actorPersonId: string,
    reason: string | undefined,
    requestId: string,
  ): Promise<{ personId: string; isBackofficeApproved: boolean }> {
    const normalizedReason = reason?.trim() || undefined;
    return this.backOffice.changePersonBackofficeApprovalAtomically({
      targetPersonId,
      actorPersonId,
      approved,
      reason: normalizedReason,
      requestId,
    });
  }
}
