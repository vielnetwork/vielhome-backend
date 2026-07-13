import { PaymentPolicy } from './payment.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('PaymentPolicy', () => {
  let policy: PaymentPolicy;

  beforeEach(() => {
    policy = new PaymentPolicy();
  });

  describe('assertPositiveAmount', () => {
    it('allows a positive amount', () => {
      expect(() => policy.assertPositiveAmount(1_000)).not.toThrow();
    });

    it('rejects a zero amount', () => {
      expect(() => policy.assertPositiveAmount(0)).toThrow(BusinessRuleViolationError);
    });

    it('rejects a negative amount', () => {
      expect(() => policy.assertPositiveAmount(-1)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertPending', () => {
    it('allows a PENDING_APPROVAL payment', () => {
      expect(() => policy.assertPending('PENDING_APPROVAL')).not.toThrow();
    });

    it('rejects an already APPROVED payment', () => {
      expect(() => policy.assertPending('APPROVED')).toThrow(BusinessRuleViolationError);
    });

    it('rejects an already REJECTED payment', () => {
      expect(() => policy.assertPending('REJECTED')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertReversible', () => {
    it('allows an APPROVED payment', () => {
      expect(() => policy.assertReversible('APPROVED')).not.toThrow();
    });

    it('rejects a PENDING_APPROVAL payment', () => {
      expect(() => policy.assertReversible('PENDING_APPROVAL')).toThrow(BusinessRuleViolationError);
    });

    it('rejects an already REVERSED payment', () => {
      expect(() => policy.assertReversible('REVERSED')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertRefundable', () => {
    it('allows a valid partial refund of an APPROVED payment', () => {
      expect(() => policy.assertRefundable('APPROVED', 500, 1_000, false)).not.toThrow();
    });

    it('rejects a non-APPROVED payment', () => {
      expect(() => policy.assertRefundable('PENDING_APPROVAL', 500, 1_000, false)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects a payment already refunded', () => {
      expect(() => policy.assertRefundable('APPROVED', 500, 1_000, true)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects a zero or negative refund amount', () => {
      expect(() => policy.assertRefundable('APPROVED', 0, 1_000, false)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects a refund amount exceeding the original payment', () => {
      expect(() => policy.assertRefundable('APPROVED', 1_001, 1_000, false)).toThrow(
        BusinessRuleViolationError,
      );
    });
  });
});
