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

    it.each(['APPROVED', 'REJECTED', 'ARCHIVED'] as const)(
      'refuses reviewing a %s listing',
      (status) => {
        expect(() => policy.assertReviewable(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('assertEditable (ADR-097)', () => {
    it('allows editing a REJECTED listing', () => {
      expect(() => policy.assertEditable('REJECTED')).not.toThrow();
    });

    it.each(['PENDING', 'APPROVED', 'ARCHIVED'] as const)(
      'refuses editing a %s listing',
      (status) => {
        expect(() => policy.assertEditable(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('assertResubmittable (ADR-097)', () => {
    it('allows resubmitting a REJECTED listing', () => {
      expect(() => policy.assertResubmittable('REJECTED')).not.toThrow();
    });

    it.each(['PENDING', 'APPROVED', 'ARCHIVED'] as const)(
      'refuses resubmitting a %s listing',
      (status) => {
        expect(() => policy.assertResubmittable(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('assertArchivable (ADR-097)', () => {
    it('allows archiving an APPROVED listing', () => {
      expect(() => policy.assertArchivable('APPROVED')).not.toThrow();
    });

    it.each(['PENDING', 'REJECTED', 'ARCHIVED'] as const)(
      'refuses archiving a %s listing',
      (status) => {
        expect(() => policy.assertArchivable(status)).toThrow(BusinessRuleViolationError);
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
