import { Injectable } from '@nestjs/common';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

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
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Single entry point for both directions (`false -> true` and
   * `true -> false` — requirement 1: "do not create a grant-only
   * workflow"). Idempotent: setting the same value twice still records an
   * audit entry (a deliberate choice — an explicit no-op re-confirmation
   * by staff is still a real, auditable action) but never throws for
   * "already in that state."
   */
  async setBackofficeApproval(
    targetPersonId: string,
    approved: boolean,
    actorPersonId: string,
    reason: string | undefined,
    requestId: string,
  ): Promise<{ personId: string; isBackofficeApproved: boolean }> {
    const target = await this.backOffice.findPersonForBackofficeApproval(targetPersonId);
    if (!target) {
      throw new NotFoundAppError('Person not found.');
    }

    const previousValue = target.isBackofficeApproved;
    const updated = await this.backOffice.setPersonBackofficeApproval(targetPersonId, approved);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'PersonBackofficeApprovalChanged',
      entityType: 'Person',
      entityId: targetPersonId,
      reason,
      metadata: {
        previousValue,
        newValue: updated.isBackofficeApproved,
      },
      requestId,
    });

    return { personId: updated.id, isBackofficeApproved: updated.isBackofficeApproved };
  }
}
