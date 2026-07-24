import { FundPolicy } from './fund.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('FundPolicy', () => {
  let policy: FundPolicy;

  beforeEach(() => {
    policy = new FundPolicy();
  });

  describe('assertDeactivatable', () => {
    it('allows deactivating a non-default fund', () => {
      expect(() => policy.assertDeactivatable(false)).not.toThrow();
    });

    it('rejects deactivating the default fund', () => {
      expect(() => policy.assertDeactivatable(true)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertActive', () => {
    it('allows modifying an active fund', () => {
      expect(() => policy.assertActive(true)).not.toThrow();
    });

    it('rejects modifying a deactivated fund', () => {
      expect(() => policy.assertActive(false)).toThrow(BusinessRuleViolationError);
    });
  });
});
