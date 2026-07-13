import { ServiceProviderPolicy } from './service-provider.policy';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

describe('ServiceProviderPolicy', () => {
  const policy = new ServiceProviderPolicy();

  describe('assertReviewable', () => {
    it('allows reviewing a PENDING listing', () => {
      expect(() => policy.assertReviewable('PENDING')).not.toThrow();
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'refuses reviewing an already-decided %s listing',
      (status) => {
        expect(() => policy.assertReviewable(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('assertVisibleToNonStaff', () => {
    it('allows the submitter to see their own listing', () => {
      expect(() => policy.assertVisibleToNonStaff('person-1', 'person-1')).not.toThrow();
    });

    it('refuses a different caller', () => {
      expect(() => policy.assertVisibleToNonStaff('person-1', 'person-2')).toThrow(
        AuthorizationError,
      );
    });
  });
});
