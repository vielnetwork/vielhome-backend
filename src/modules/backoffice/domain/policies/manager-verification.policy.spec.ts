import { ManagerVerificationPolicy } from './manager-verification.policy';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('ManagerVerificationPolicy', () => {
  const policy = new ManagerVerificationPolicy();

  describe('meetsApprovalThreshold', () => {
    it('is false with zero total owners', () => {
      expect(policy.meetsApprovalThreshold(0, 0, 30)).toBe(false);
    });

    it('is false just below the threshold', () => {
      // 2/10 = 20% < 30%
      expect(policy.meetsApprovalThreshold(2, 10, 30)).toBe(false);
    });

    it('is true exactly at the threshold', () => {
      // 3/10 = 30% >= 30%
      expect(policy.meetsApprovalThreshold(3, 10, 30)).toBe(true);
    });

    it('is true above the threshold', () => {
      expect(policy.meetsApprovalThreshold(7, 10, 30)).toBe(true);
    });
  });

  describe('computeApprovalPercent', () => {
    it('returns 0 with zero total owners', () => {
      expect(policy.computeApprovalPercent(0, 0)).toBe(0);
    });

    it('floors fractional percentages', () => {
      // 1/3 = 33.33...% -> 33
      expect(policy.computeApprovalPercent(1, 3)).toBe(33);
    });
  });

  describe('assertCaseOpen', () => {
    it('allows a PENDING case', () => {
      expect(() => policy.assertCaseOpen('PENDING')).not.toThrow();
    });

    it.each(['VERIFIED', 'REJECTED', 'SUSPENDED'] as const)('refuses a decided %s case', (status) => {
      expect(() => policy.assertCaseOpen(status)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertNotSelfApproving', () => {
    it('refuses the candidate approving themself', () => {
      expect(() => policy.assertNotSelfApproving('person-1', 'person-1')).toThrow(AuthorizationError);
    });

    it('allows a different owner to approve', () => {
      expect(() => policy.assertNotSelfApproving('person-1', 'person-2')).not.toThrow();
    });
  });

  describe('assertCanAppeal', () => {
    it('allows the rejected candidate to appeal', () => {
      expect(() => policy.assertCanAppeal('REJECTED', 'person-1', 'person-1')).not.toThrow();
    });

    it('refuses appeal on a non-rejected case', () => {
      expect(() => policy.assertCanAppeal('PENDING', 'person-1', 'person-1')).toThrow(BusinessRuleViolationError);
    });

    it('refuses appeal from someone other than the candidate', () => {
      expect(() => policy.assertCanAppeal('REJECTED', 'person-2', 'person-1')).toThrow(AuthorizationError);
    });
  });

  describe('assertCanRestore', () => {
    it('allows restoring a SUSPENDED case', () => {
      expect(() => policy.assertCanRestore('SUSPENDED')).not.toThrow();
    });

    it.each(['PENDING', 'VERIFIED', 'REJECTED'] as const)('refuses restoring a %s case', (status) => {
      expect(() => policy.assertCanRestore(status)).toThrow(BusinessRuleViolationError);
    });
  });
});
