import { SubscriptionPolicy } from './subscription.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('SubscriptionPolicy', () => {
  const policy = new SubscriptionPolicy();

  describe('planIncludesFeature', () => {
    it('Free plan includes its own active features', () => {
      expect(policy.planIncludesFeature('FREE', 'BASIC_CHARGES')).toBe(true);
    });

    it('Free plan does not include Pro-only features', () => {
      expect(policy.planIncludesFeature('FREE', 'SMS')).toBe(false);
    });

    it('Pro plan includes both Free and Pro-only features', () => {
      expect(policy.planIncludesFeature('PRO', 'BASIC_CHARGES')).toBe(true);
      expect(policy.planIncludesFeature('PRO', 'SMS')).toBe(true);
    });

    it('Enterprise plan includes everything Pro includes', () => {
      expect(policy.planIncludesFeature('ENTERPRISE', 'SMS')).toBe(true);
    });
  });

  describe('resolveEffectiveFeatures', () => {
    it('denies a Pro-only feature on Free with no grants', () => {
      const result = policy.resolveEffectiveFeatures('FREE', []);
      const sms = result.find((r) => r.featureKey === 'SMS');
      expect(sms?.result).toBe('DENIED');
      expect(sms?.source).toBe('PLAN');
    });

    it('allows a Pro-only feature on Free when actively granted', () => {
      const result = policy.resolveEffectiveFeatures('FREE', ['SMS']);
      const sms = result.find((r) => r.featureKey === 'SMS');
      expect(sms?.result).toBe('ALLOWED');
      expect(sms?.source).toBe('GRANT');
    });

    it('every feature resolves to a deterministic ALLOWED/DENIED result (Rule 022)', () => {
      const result = policy.resolveEffectiveFeatures('FREE', []);
      expect(result.every((r) => r.result === 'ALLOWED' || r.result === 'DENIED')).toBe(true);
    });
  });

  describe('isGrantActive', () => {
    const now = new Date('2026-01-15T00:00:00Z');

    it('is active with no expiry and no revocation', () => {
      expect(policy.isGrantActive({ expiresAt: null, revokedAt: null }, now)).toBe(true);
    });

    it('is inactive once revoked', () => {
      expect(
        policy.isGrantActive({ expiresAt: null, revokedAt: new Date('2026-01-10T00:00:00Z') }, now),
      ).toBe(false);
    });

    it('is inactive once expired', () => {
      expect(
        policy.isGrantActive({ expiresAt: new Date('2026-01-14T00:00:00Z'), revokedAt: null }, now),
      ).toBe(false);
    });

    it('is active before its expiry', () => {
      expect(
        policy.isGrantActive({ expiresAt: new Date('2026-02-01T00:00:00Z'), revokedAt: null }, now),
      ).toBe(true);
    });
  });

  describe('assertTrialAvailable', () => {
    it('allows a building that has not used its trial', () => {
      expect(() => policy.assertTrialAvailable(false)).not.toThrow();
    });

    it('refuses a building that already used its trial', () => {
      expect(() => policy.assertTrialAvailable(true)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertGrantRevocable', () => {
    it('allows revoking a not-yet-revoked grant', () => {
      expect(() => policy.assertGrantRevocable(null)).not.toThrow();
    });

    it('refuses revoking an already-revoked grant', () => {
      expect(() => policy.assertGrantRevocable(new Date())).toThrow(BusinessRuleViolationError);
    });
  });
});
