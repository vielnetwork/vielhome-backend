import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * Business rules for Payments (12_Finance_Architecture > "Payment
 * Lifecycle", reconciled from 10.08.01_Finance_Architecture). See the MVP
 * simplification note in `schema.prisma` for why the lifecycle here is
 * PENDING_APPROVAL -> APPROVED/REJECTED rather than the Frozen doc's full
 * 6-stage lifecycle. Never touches persistence.
 */
@Injectable()
export class PaymentPolicy {
  assertPositiveAmount(amount: number): void {
    if (!amount || amount <= 0) {
      throw new BusinessRuleViolationError('A payment amount must be positive.');
    }
  }

  /**
   * Only a PENDING_APPROVAL payment may be approved or rejected — an
   * already-resolved payment is a closed financial event
   * (05_Business_Rules > Finance Rules: "Payments never overwrite previous
   * payments").
   */
  assertPending(status: string): void {
    if (status !== 'PENDING_APPROVAL') {
      throw new BusinessRuleViolationError(
        `This payment has already been ${status.toLowerCase()}.`,
      );
    }
  }

  /**
   * Only an APPROVED payment can be reversed (08.06 Rule 010/011 — see
   * 21_ADRs > ADR-037) — reversal undoes a real approval's effect, so
   * there must be an effect to undo. A PENDING_APPROVAL payment should be
   * rejected instead; an already-REVERSED/REFUNDED payment can't be
   * reversed again.
   */
  assertReversible(status: string): void {
    if (status !== 'APPROVED') {
      throw new BusinessRuleViolationError(
        `Only an APPROVED payment can be reversed (this one is ${status}).`,
      );
    }
  }

  /**
   * Only an APPROVED payment can be refunded, for a positive amount not
   * exceeding what was actually paid, and only once per payment — 08.06's
   * own `Refund` model has no "remaining refundable amount" concept, so
   * this MVP doesn't stack partial refunds (see the `Refund` model's own
   * schema comment).
   */
  assertRefundable(
    status: string,
    refundAmount: number,
    paymentAmount: number,
    alreadyRefunded: boolean,
  ): void {
    if (status !== 'APPROVED') {
      throw new BusinessRuleViolationError(
        `Only an APPROVED payment can be refunded (this one is ${status}).`,
      );
    }
    if (alreadyRefunded) {
      throw new BusinessRuleViolationError('This payment has already been refunded.');
    }
    if (!refundAmount || refundAmount <= 0) {
      throw new BusinessRuleViolationError('A refund amount must be positive.');
    }
    if (refundAmount > paymentAmount) {
      throw new BusinessRuleViolationError('A refund cannot exceed the original payment amount.');
    }
  }
}
