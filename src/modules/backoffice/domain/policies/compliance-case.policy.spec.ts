import { ComplianceCasePolicy } from './compliance-case.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('ComplianceCasePolicy', () => {
  const policy = new ComplianceCasePolicy();

  describe('assertInvestigable', () => {
    it.each(['OPEN', 'UNDER_INVESTIGATION'] as const)('allows an open %s case', (status) => {
      expect(() => policy.assertInvestigable(status)).not.toThrow();
    });

    it.each(['CONFIRMED', 'DISMISSED'] as const)('refuses a decided %s case', (status) => {
      expect(() => policy.assertInvestigable(status)).toThrow(BusinessRuleViolationError);
    });
  });
});
