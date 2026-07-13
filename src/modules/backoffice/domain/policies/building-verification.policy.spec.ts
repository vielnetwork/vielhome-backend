import { BuildingVerificationPolicy } from './building-verification.policy';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('BuildingVerificationPolicy', () => {
  const policy = new BuildingVerificationPolicy();

  describe('evaluateRisk', () => {
    it('returns zero score and no flags when no similar address exists', () => {
      expect(policy.evaluateRisk(false)).toEqual({ score: 0, flags: [] });
    });

    it('flags SIMILAR_ADDRESS_DIFFERENT_POSTAL_CODE and scores 50 when one exists', () => {
      expect(policy.evaluateRisk(true)).toEqual({ score: 50, flags: ['SIMILAR_ADDRESS_DIFFERENT_POSTAL_CODE'] });
    });
  });

  describe('isAutoApproved', () => {
    it('is true for a zero risk score', () => {
      expect(policy.isAutoApproved(0)).toBe(true);
    });

    it('is false for any positive risk score', () => {
      expect(policy.isAutoApproved(50)).toBe(false);
    });
  });

  describe('assertDecidable', () => {
    it.each(['PENDING', 'UNDER_REVIEW', 'PENDING_INFORMATION'] as const)('allows deciding a %s case', (status) => {
      expect(() => policy.assertDecidable(status)).not.toThrow();
    });

    it.each(['VERIFIED', 'REJECTED', 'MERGED'] as const)('refuses deciding an already-terminal %s case', (status) => {
      expect(() => policy.assertDecidable(status)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanAppeal', () => {
    it('allows the creator to appeal a rejected building', () => {
      expect(() => policy.assertCanAppeal('REJECTED', 'person-1', 'person-1')).not.toThrow();
    });

    it('refuses appeal on a non-rejected building', () => {
      expect(() => policy.assertCanAppeal('UNDER_REVIEW', 'person-1', 'person-1')).toThrow(BusinessRuleViolationError);
    });

    it('refuses appeal from someone other than the creator', () => {
      expect(() => policy.assertCanAppeal('REJECTED', 'person-2', 'person-1')).toThrow(AuthorizationError);
    });
  });
});
