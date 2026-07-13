import { SupportCasePolicy } from './support-case.policy';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

describe('SupportCasePolicy', () => {
  const policy = new SupportCasePolicy();

  describe('assertActionable', () => {
    it.each(['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED'] as const)(
      'allows acting on a %s case',
      (status) => {
        expect(() => policy.assertActionable(status)).not.toThrow();
      },
    );

    it('refuses acting on a CLOSED case', () => {
      expect(() => policy.assertActionable('CLOSED')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertResolvedForClose', () => {
    it('allows closing a RESOLVED case', () => {
      expect(() => policy.assertResolvedForClose('RESOLVED')).not.toThrow();
    });

    it.each(['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'CLOSED'] as const)(
      'refuses closing a %s case',
      (status) => {
        expect(() => policy.assertResolvedForClose(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('assertCanReopen', () => {
    it.each(['RESOLVED', 'CLOSED'] as const)('allows reopening a %s case', (status) => {
      expect(() => policy.assertCanReopen(status)).not.toThrow();
    });

    it.each(['OPEN', 'IN_PROGRESS', 'WAITING_USER'] as const)(
      'refuses reopening a %s case',
      (status) => {
        expect(() => policy.assertCanReopen(status)).toThrow(BusinessRuleViolationError);
      },
    );
  });

  describe('nextEscalatedPriority', () => {
    it('steps up one level at a time', () => {
      expect(policy.nextEscalatedPriority('LOW')).toBe('NORMAL');
      expect(policy.nextEscalatedPriority('NORMAL')).toBe('HIGH');
      expect(policy.nextEscalatedPriority('HIGH')).toBe('CRITICAL');
    });

    it('refuses escalating past CRITICAL', () => {
      expect(() => policy.nextEscalatedPriority('CRITICAL')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertVisibleToNonStaff', () => {
    it('allows the creator', () => {
      expect(() => policy.assertVisibleToNonStaff('person-1', 'person-1')).not.toThrow();
    });

    it('refuses a different person', () => {
      expect(() => policy.assertVisibleToNonStaff('person-1', 'person-2')).toThrow(
        AuthorizationError,
      );
    });
  });
});
