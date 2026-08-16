import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * Business rules for building Expenses / Disbursements (FIN-EXP-01/
 * FIN-EXP-02 — see 21_ADRs > ADR-126). Never touches persistence
 * (11_Backend_Architecture > Domain Layer) — only asserts. Mirrors
 * `FundPolicy`/`PaymentPolicy`'s shape: a small set of pure, injectable
 * assertion methods called from the service layer before the repository
 * transaction runs.
 */
@Injectable()
export class ExpensePolicy {
  /**
   * Same style as `ChargePolicy.assertValidAdjustmentAmount`, but
   * positive-only (unlike Adjustment's signed amount) — an Expense always
   * represents money that left the building, never a correction that can
   * go either direction.
   */
  assertValidAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BusinessRuleViolationError('An expense amount must be a positive integer.');
    }
  }

  /**
   * A fund physically cannot spend cash it doesn't hold — unlike a
   * resident debt waiver (Adjustment), which is allowed to leave residual
   * unmet debt, an Expense's cash effect is real and must never drive
   * `Fund.balance` negative (Task 1/11 of the FIN-EXP-01 design). This is
   * a fast, friendly pre-check; `FinanceRepository.createExpense` re-reads
   * the fund's balance again inside its own transaction as the
   * authoritative check against a concurrent write shrinking the balance
   * in the gap between this check and the transaction (same
   * fast-pre-check / authoritative-check split `VotingService.closeVote`
   * already establishes for a different race).
   */
  assertSufficientFundBalance(fundBalance: number, amount: number): void {
    if (fundBalance < amount) {
      throw new BusinessRuleViolationError(
        "This expense's amount exceeds the fund's current balance.",
      );
    }
  }

  /** An Expense is immutable after creation — the only correction path is VOID, never edit or delete. */
  assertVoidable(status: 'POSTED' | 'VOIDED'): void {
    if (status === 'VOIDED') {
      throw new BusinessRuleViolationError('This expense has already been voided.');
    }
  }
}
