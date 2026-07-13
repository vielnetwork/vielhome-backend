import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

export interface ChargeBatchLike {
  status: string;
}

/**
 * Business rules for Charges (12_Finance_Architecture > "Charge Lifecycle",
 * reconciled from 10.08.01_Finance_Architecture). See the MVP simplification
 * note at the top of the Finance section in `schema.prisma` for why the
 * lifecycle here is DRAFT -> ISSUED -> CLOSED/CANCELLED rather than the
 * Frozen doc's full 7-stage lifecycle. Never touches persistence
 * (11_Backend_Architecture > Domain Layer) — only asserts.
 */
@Injectable()
export class ChargePolicy {
  /** Exactly one calculation input set must be present, matching the method. */
  assertValidCalculationInputs(
    method: 'FIXED' | 'AREA_BASED' | 'MIXED',
    input: {
      amountPerUnit?: number;
      ratePerSqm?: number;
      items?: Array<{ unitId: string; amount: number }>;
    },
  ): void {
    if (method === 'FIXED') {
      if (!input.amountPerUnit || input.amountPerUnit <= 0) {
        throw new BusinessRuleViolationError(
          'A FIXED charge batch requires a positive amountPerUnit.',
        );
      }
      return;
    }
    if (method === 'AREA_BASED') {
      if (!input.ratePerSqm || input.ratePerSqm <= 0) {
        throw new BusinessRuleViolationError(
          'An AREA_BASED charge batch requires a positive ratePerSqm.',
        );
      }
      return;
    }
    // MIXED
    if (!input.items || input.items.length === 0) {
      throw new BusinessRuleViolationError(
        'A MIXED charge batch requires at least one explicit item.',
      );
    }
    if (input.items.some((i) => i.amount <= 0)) {
      throw new BusinessRuleViolationError('Every MIXED charge item amount must be positive.');
    }
  }

  /** A batch cannot be issued twice, and an empty batch has nothing to collect. */
  assertIssuable(status: string, totalAmount: number): void {
    if (status !== 'DRAFT') {
      throw new BusinessRuleViolationError('Only a DRAFT charge batch can be issued.');
    }
    if (totalAmount <= 0) {
      throw new BusinessRuleViolationError('A charge batch with no charge items cannot be issued.');
    }
  }

  /**
   * A batch that already has money applied against it (any item partially
   * or fully paid) cannot be cancelled outright — Frozen Finance Rules
   * ("Payments never overwrite previous payments") means we never silently
   * unwind a payment by cancelling the charge it was allocated to. Refund
   * the payment first (future capability), or leave the batch CLOSED.
   */
  assertCancellable(status: string, hasAnyPaidAmount: boolean): void {
    if (status === 'CLOSED' || status === 'CANCELLED') {
      throw new BusinessRuleViolationError(`A ${status} charge batch cannot be cancelled again.`);
    }
    if (hasAnyPaidAmount) {
      throw new BusinessRuleViolationError(
        'This charge batch has payments already applied to it and cannot be cancelled.',
      );
    }
  }

  /**
   * An Adjustment (08.05 Rule 014 — see 21_ADRs > ADR-037) must actually
   * change something — a zero adjustment is neither a waiver nor an added
   * charge, just noise in the ledger.
   */
  assertValidAdjustmentAmount(amount: number): void {
    if (!amount || amount === 0) {
      throw new BusinessRuleViolationError('An adjustment amount must be non-zero.');
    }
  }
}
