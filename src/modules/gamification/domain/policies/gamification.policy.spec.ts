import { GamificationPolicy } from './gamification.policy';

describe('GamificationPolicy', () => {
  const policy = new GamificationPolicy();

  describe('computeLeagueTier', () => {
    it('returns BRONZE for a score of 0', () => {
      expect(policy.computeLeagueTier(0)).toBe('BRONZE');
    });

    it('returns BRONZE just below the SILVER threshold', () => {
      expect(policy.computeLeagueTier(99)).toBe('BRONZE');
    });

    it('returns SILVER exactly at its threshold', () => {
      expect(policy.computeLeagueTier(100)).toBe('SILVER');
    });

    it('returns GOLD exactly at its threshold', () => {
      expect(policy.computeLeagueTier(300)).toBe('GOLD');
    });

    it('returns PLATINUM exactly at its threshold', () => {
      expect(policy.computeLeagueTier(700)).toBe('PLATINUM');
    });

    it('returns DIAMOND at and above its threshold', () => {
      expect(policy.computeLeagueTier(1500)).toBe('DIAMOND');
      expect(policy.computeLeagueTier(50000)).toBe('DIAMOND');
    });
  });

  describe('isPromotion', () => {
    it('is true when moving up a tier', () => {
      expect(policy.isPromotion('BRONZE', 'SILVER')).toBe(true);
      expect(policy.isPromotion('GOLD', 'DIAMOND')).toBe(true);
    });

    it('is false when moving down a tier', () => {
      expect(policy.isPromotion('GOLD', 'BRONZE')).toBe(false);
      expect(policy.isPromotion('DIAMOND', 'PLATINUM')).toBe(false);
    });

    it('is false when the tier is unchanged', () => {
      expect(policy.isPromotion('SILVER', 'SILVER')).toBe(false);
    });
  });
});
