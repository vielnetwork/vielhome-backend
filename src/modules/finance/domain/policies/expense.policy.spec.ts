import { ExpensePolicy } from './expense.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('ExpensePolicy', () => {
  let policy: ExpensePolicy;

  beforeEach(() => {
    policy = new ExpensePolicy();
  });

  describe('assertValidAmount', () => {
    it('allows a positive integer amount', () => {
      expect(() => policy.assertValidAmount(1)).not.toThrow();
      expect(() => policy.assertValidAmount(5_000_000)).not.toThrow();
    });

    it('rejects zero', () => {
      expect(() => policy.assertValidAmount(0)).toThrow(BusinessRuleViolationError);
    });

    it('rejects a negative amount', () => {
      expect(() => policy.assertValidAmount(-100)).toThrow(BusinessRuleViolationError);
    });

    it('rejects a non-integer amount', () => {
      expect(() => policy.assertValidAmount(12.5)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertSufficientFundBalance', () => {
    it('allows an amount less than the fund balance', () => {
      expect(() => policy.assertSufficientFundBalance(1_000_000, 500_000)).not.toThrow();
    });

    it('allows an amount exactly equal to the fund balance', () => {
      expect(() => policy.assertSufficientFundBalance(1_000_000, 1_000_000)).not.toThrow();
    });

    it('rejects an amount exceeding the fund balance', () => {
      expect(() => policy.assertSufficientFundBalance(100, 200)).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('assertVoidable', () => {
    it('allows voiding a POSTED expense', () => {
      expect(() => policy.assertVoidable('POSTED')).not.toThrow();
    });

    it('rejects voiding an already-VOIDED expense', () => {
      expect(() => policy.assertVoidable('VOIDED')).toThrow(BusinessRuleViolationError);
    });
  });
});
