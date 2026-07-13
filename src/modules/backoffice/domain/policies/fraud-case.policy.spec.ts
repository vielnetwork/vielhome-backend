import { FraudCasePolicy } from './fraud-case.policy';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

describe('FraudCasePolicy', () => {
  const policy = new FraudCasePolicy();

  describe('assertInvestigable', () => {
    it.each(['OPEN', 'UNDER_INVESTIGATION'] as const)('allows an open %s case', (status) => {
      expect(() => policy.assertInvestigable(status)).not.toThrow();
    });

    it.each(['CONFIRMED', 'DISMISSED'] as const)('refuses a decided %s case', (status) => {
      expect(() => policy.assertInvestigable(status)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanReopen', () => {
    it.each(['CONFIRMED', 'DISMISSED'] as const)(
      'allows reopening a terminal %s case',
      (status) => {
        expect(() => policy.assertCanReopen(status)).not.toThrow();
      },
    );

    it.each(['OPEN', 'UNDER_INVESTIGATION'] as const)(
      'refuses reopening a still-open %s case',
      (status) => {
        expect(() => policy.assertCanReopen(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('assertCanAppealEnforcement', () => {
    it('allows the target person to appeal a fresh action', () => {
      expect(() => policy.assertCanAppealEnforcement('NONE', 'person-1', 'person-1')).not.toThrow();
    });

    it('refuses a second appeal', () => {
      expect(() => policy.assertCanAppealEnforcement('PENDING', 'person-1', 'person-1')).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('refuses appeal from someone other than the target', () => {
      expect(() => policy.assertCanAppealEnforcement('NONE', 'person-1', 'person-2')).toThrow(
        AuthorizationError,
      );
    });
  });

  describe('assertAppealDecidable', () => {
    it('allows deciding a PENDING appeal', () => {
      expect(() => policy.assertAppealDecidable('PENDING')).not.toThrow();
    });

    it.each(['NONE', 'UPHELD', 'OVERTURNED'] as const)('refuses deciding a %s appeal', (status) => {
      expect(() => policy.assertAppealDecidable(status)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanIssueEnforcement', () => {
    it('allows PLATFORM_ADMIN to issue ACCOUNT_SUSPENSION', () => {
      expect(() =>
        policy.assertCanIssueEnforcement('ACCOUNT_SUSPENSION', 'PLATFORM_ADMIN'),
      ).not.toThrow();
    });

    it.each(['REVIEWER', 'SENIOR_REVIEWER'] as const)(
      'refuses %s issuing ACCOUNT_SUSPENSION',
      (role) => {
        expect(() => policy.assertCanIssueEnforcement('ACCOUNT_SUSPENSION', role)).toThrow(
          AuthorizationError,
        );
      },
    );

    it.each(['WARNING', 'TEMPORARY_RESTRICTION', 'VERIFICATION_REVOCATION'] as const)(
      'allows SENIOR_REVIEWER to issue %s (unaffected by the ACCOUNT_SUSPENSION gate)',
      (type) => {
        expect(() => policy.assertCanIssueEnforcement(type, 'SENIOR_REVIEWER')).not.toThrow();
      },
    );

    it.each(['WARNING', 'TEMPORARY_RESTRICTION', 'VERIFICATION_REVOCATION'] as const)(
      'allows REVIEWER to issue %s too — this policy only gates ACCOUNT_SUSPENSION, the route-level @PlatformRoles(SENIOR_REVIEWER) already covers the rest',
      (type) => {
        expect(() => policy.assertCanIssueEnforcement(type, 'REVIEWER')).not.toThrow();
      },
    );
  });
});
