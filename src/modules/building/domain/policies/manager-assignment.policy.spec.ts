import { ManagerAssignmentPolicy } from './manager-assignment.policy';
import { BusinessRuleViolationError, ConflictError } from '../../../../common/errors/app-error';

describe('ManagerAssignmentPolicy', () => {
  const policy = new ManagerAssignmentPolicy();

  it('rejects assigning management to a non-member', () => {
    expect(() => policy.assertCandidateIsMember(false)).toThrow(BusinessRuleViolationError);
  });

  it('allows assigning management to an existing member', () => {
    expect(() => policy.assertCandidateIsMember(true)).not.toThrow();
  });

  it('rejects handing off management to the current manager', () => {
    expect(() => policy.assertNotSelfHandoff('p1', 'p1')).toThrow(BusinessRuleViolationError);
  });

  it('allows handing off to a different person', () => {
    expect(() => policy.assertNotSelfHandoff('p1', 'p2')).not.toThrow();
  });

  it('allows handoff when there was no prior manager', () => {
    expect(() => policy.assertNotSelfHandoff(undefined, 'p2')).not.toThrow();
  });

  it('rejects assigning a manager when one is already active', () => {
    expect(() =>
      policy.assertNoActiveManager({ id: 'm1', personId: 'p1', managerState: 'VERIFIED' }),
    ).toThrow(ConflictError);
  });

  it('allows assigning a manager when none is active', () => {
    expect(() => policy.assertNoActiveManager(null)).not.toThrow();
  });

  it('rejects verifying a non-provisional manager', () => {
    expect(() => policy.assertProvisional('VERIFIED')).toThrow(BusinessRuleViolationError);
    expect(() => policy.assertProvisional(null)).toThrow(BusinessRuleViolationError);
  });

  it('allows verifying a provisional manager', () => {
    expect(() => policy.assertProvisional('PROVISIONAL')).not.toThrow();
  });

  it('rejects operations that require an active manager when there is none', () => {
    expect(() => policy.assertHasActiveManager(null)).toThrow(BusinessRuleViolationError);
  });

  it('allows operations that require an active manager when one exists', () => {
    expect(() =>
      policy.assertHasActiveManager({ id: 'm1', personId: 'p1', managerState: 'VERIFIED' }),
    ).not.toThrow();
  });
});
