import { Injectable } from '@nestjs/common';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { LegalHoldPolicy } from '../domain/policies/legal-hold.policy';
import { AuditService } from '../../../common/audit/audit.service';

/**
 * Legal Hold (07.06_Audit_And_Compliance_Center_v1.0 Rule 015 — see
 * 21_ADRs > ADR-034). `AuditLog`'s own MVP retention policy is already
 * "Never Delete" (Rule 009), so this is pure recorded state this sprint —
 * there is no purge job for a hold to actually block yet.
 */
@Injectable()
export class LegalHoldService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: LegalHoldPolicy,
    private readonly audit: AuditService,
  ) {}

  async place(
    params: { entityType: string; entityId: string; reason: string },
    staffPersonId: string,
    requestId: string,
  ) {
    const existing = await this.backOffice.findActiveLegalHold(params.entityType, params.entityId);
    this.policy.assertCanPlace(existing);

    const hold = await this.backOffice.createLegalHold({
      entityType: params.entityType,
      entityId: params.entityId,
      reason: params.reason,
      placedById: staffPersonId,
    });

    await this.audit.record({
      actorId: staffPersonId,
      action: 'LegalHoldPlaced',
      entityType: 'AuditLegalHold',
      entityId: hold.id,
      requestId,
      reason: params.reason,
      metadata: { targetEntityType: params.entityType, targetEntityId: params.entityId },
    });

    return hold;
  }

  list(filters: { entityType?: string; entityId?: string; isActive?: boolean }) {
    return this.backOffice.listLegalHolds(filters);
  }

  async release(holdId: string, staffPersonId: string, requestId: string) {
    const hold = await this.backOffice.findLegalHoldById(holdId);
    this.policy.assertCanRelease(hold);

    const released = await this.backOffice.releaseLegalHold(holdId, staffPersonId);

    await this.audit.record({
      actorId: staffPersonId,
      action: 'LegalHoldReleased',
      entityType: 'AuditLegalHold',
      entityId: holdId,
      requestId,
    });

    return released;
  }
}
