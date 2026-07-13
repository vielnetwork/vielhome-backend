import { CasePolicy } from './case.policy';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('CasePolicy', () => {
  let policy: CasePolicy;

  beforeEach(() => {
    policy = new CasePolicy();
  });

  describe('assertVisible', () => {
    it('allows anyone to see a PUBLIC case', () => {
      expect(() =>
        policy.assertVisible({ visibility: 'PUBLIC', createdById: 'p1', assigneeId: null }, 'p2', false),
      ).not.toThrow();
    });

    it('allows the creator to see their own PRIVATE case', () => {
      expect(() =>
        policy.assertVisible({ visibility: 'PRIVATE', createdById: 'p1', assigneeId: null }, 'p1', false),
      ).not.toThrow();
    });

    it('allows the assignee to see a PRIVATE case', () => {
      expect(() =>
        policy.assertVisible({ visibility: 'PRIVATE', createdById: 'p1', assigneeId: 'p2' }, 'p2', false),
      ).not.toThrow();
    });

    it('allows a privileged role to see any PRIVATE case', () => {
      expect(() =>
        policy.assertVisible({ visibility: 'PRIVATE', createdById: 'p1', assigneeId: null }, 'p3', true),
      ).not.toThrow();
    });

    it('rejects an unrelated, non-privileged person', () => {
      expect(() =>
        policy.assertVisible({ visibility: 'PRIVATE', createdById: 'p1', assigneeId: null }, 'p3', false),
      ).toThrow(AuthorizationError);
    });
  });

  describe('assertEditable', () => {
    it('allows the creator to edit an open case', () => {
      expect(() => policy.assertEditable('p1', 'p1', false, 'OPEN')).not.toThrow();
    });

    it('allows a privileged role to edit any open case', () => {
      expect(() => policy.assertEditable('p1', 'p2', true, 'OPEN')).not.toThrow();
    });

    it('rejects an unrelated, non-privileged person', () => {
      expect(() => policy.assertEditable('p1', 'p2', false, 'OPEN')).toThrow(AuthorizationError);
    });

    it('rejects editing a closed case', () => {
      expect(() => policy.assertEditable('p1', 'p1', false, 'CLOSED')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanPostInternalMessage', () => {
    it('allows a non-internal message from anyone', () => {
      expect(() => policy.assertCanPostInternalMessage(false, false)).not.toThrow();
    });

    it('allows an internal message from a privileged role', () => {
      expect(() => policy.assertCanPostInternalMessage(true, true)).not.toThrow();
    });

    it('rejects an internal message from a non-privileged role', () => {
      expect(() => policy.assertCanPostInternalMessage(true, false)).toThrow(AuthorizationError);
    });
  });

  describe('assertAssignable', () => {
    it('allows assigning a normal case to anyone', () => {
      expect(() => policy.assertAssignable(false, true)).not.toThrow();
    });

    it('allows assigning a manager-complaint to a non-manager', () => {
      expect(() => policy.assertAssignable(true, false)).not.toThrow();
    });

    it('rejects assigning a manager-complaint to the manager', () => {
      expect(() => policy.assertAssignable(true, true)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertResolvable / assertCloseable / assertReopenable', () => {
    it('allows resolving an open case', () => {
      expect(() => policy.assertResolvable('OPEN')).not.toThrow();
    });

    it('rejects resolving an already resolved case', () => {
      expect(() => policy.assertResolvable('RESOLVED')).toThrow(BusinessRuleViolationError);
    });

    it('allows closing a resolved case', () => {
      expect(() => policy.assertCloseable('RESOLVED')).not.toThrow();
    });

    it('rejects closing an already closed case', () => {
      expect(() => policy.assertCloseable('CLOSED')).toThrow(BusinessRuleViolationError);
    });

    it('allows reopening a closed case', () => {
      expect(() => policy.assertReopenable('CLOSED')).not.toThrow();
    });

    it('rejects reopening an open case', () => {
      expect(() => policy.assertReopenable('OPEN')).toThrow(BusinessRuleViolationError);
    });
  });
});
