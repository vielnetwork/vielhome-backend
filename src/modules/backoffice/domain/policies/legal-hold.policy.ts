import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, NotFoundAppError } from '../../../../common/errors/app-error';

/**
 * Pure business rules for Legal Hold (07.06_Audit_And_Compliance_Center_
 * v1.0 Rule 015 — see 21_ADRs > ADR-034). One active hold per entity at a
 * time — no source rule describes stacking multiple concurrent holds on
 * the same entity, and a single `isActive` flag per hold is simpler to
 * reason about than a count.
 */
@Injectable()
export class LegalHoldPolicy {
  assertCanPlace(existingActiveHold: { id: string } | null): void {
    if (existingActiveHold) {
      throw new BusinessRuleViolationError('This entity already has an active legal hold.');
    }
  }

  assertCanRelease(hold: { isActive: boolean } | null): void {
    if (!hold) {
      throw new NotFoundAppError('Legal hold not found.');
    }
    if (!hold.isActive) {
      throw new BusinessRuleViolationError('This legal hold has already been released.');
    }
  }
}
