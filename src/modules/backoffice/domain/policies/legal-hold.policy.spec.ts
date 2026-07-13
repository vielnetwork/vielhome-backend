import { LegalHoldPolicy } from './legal-hold.policy';
import { BusinessRuleViolationError, NotFoundAppError } from '../../../../common/errors/app-error';

describe('LegalHoldPolicy', () => {
  const policy = new LegalHoldPolicy();

  describe('assertCanPlace', () => {
    it('allows placing a hold when none is active', () => {
      expect(() => policy.assertCanPlace(null)).not.toThrow();
    });

    it('refuses placing a second hold on the same entity', () => {
      expect(() => policy.assertCanPlace({ id: 'hold-1' })).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanRelease', () => {
    it('allows releasing an active hold', () => {
      expect(() => policy.assertCanRelease({ isActive: true })).not.toThrow();
    });

    it('refuses releasing an already-released hold', () => {
      expect(() => policy.assertCanRelease({ isActive: false })).toThrow(BusinessRuleViolationError);
    });

    it('refuses releasing a hold that does not exist', () => {
      expect(() => policy.assertCanRelease(null)).toThrow(NotFoundAppError);
    });
  });
});
