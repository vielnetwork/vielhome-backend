import { VotePolicy } from './vote.policy';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

describe('VotePolicy', () => {
  let policy: VotePolicy;

  beforeEach(() => {
    policy = new VotePolicy();
  });

  describe('assertValidVoteWindow', () => {
    it('accepts a future end date after the start date', () => {
      const start = new Date(Date.now() + 1_000);
      const end = new Date(Date.now() + 10_000);
      expect(() => policy.assertValidVoteWindow(start, end)).not.toThrow();
    });

    it('rejects an end date before the start date', () => {
      const start = new Date(Date.now() + 10_000);
      const end = new Date(Date.now() + 1_000);
      expect(() => policy.assertValidVoteWindow(start, end)).toThrow(BusinessRuleViolationError);
    });

    it('rejects an end date in the past', () => {
      const start = new Date(Date.now() - 10_000);
      const end = new Date(Date.now() - 1_000);
      expect(() => policy.assertValidVoteWindow(start, end)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertPublishable', () => {
    it('allows a DRAFT vote with 2+ options', () => {
      expect(() => policy.assertPublishable('DRAFT', 3)).not.toThrow();
    });

    it('rejects a non-DRAFT vote', () => {
      expect(() => policy.assertPublishable('ACTIVE', 3)).toThrow(BusinessRuleViolationError);
    });

    it('rejects a vote with fewer than 2 options', () => {
      expect(() => policy.assertPublishable('DRAFT', 1)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertValidElectionOptions', () => {
    it('accepts distinct candidates', () => {
      expect(() => policy.assertValidElectionOptions(['p1', 'p2'])).not.toThrow();
    });

    it('rejects an empty candidate list', () => {
      expect(() => policy.assertValidElectionOptions([])).toThrow(BusinessRuleViolationError);
    });

    it('rejects a duplicate candidate', () => {
      expect(() => policy.assertValidElectionOptions(['p1', 'p1'])).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('assertOpenForBallots', () => {
    it('allows an ACTIVE vote within its window', () => {
      expect(() =>
        policy.assertOpenForBallots('ACTIVE', new Date(Date.now() + 10_000)),
      ).not.toThrow();
    });

    it('rejects a non-ACTIVE vote', () => {
      expect(() => policy.assertOpenForBallots('DRAFT', new Date(Date.now() + 10_000))).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects an ACTIVE vote past its end date', () => {
      expect(() => policy.assertOpenForBallots('ACTIVE', new Date(Date.now() - 10_000))).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('assertNotVotingOnOwnCandidacy', () => {
    it('allows a non-election vote regardless of candidates', () => {
      expect(() => policy.assertNotVotingOnOwnCandidacy(false, 'p1', ['p1'])).not.toThrow();
    });

    it('allows a voter who is not a candidate', () => {
      expect(() => policy.assertNotVotingOnOwnCandidacy(true, 'p3', ['p1', 'p2'])).not.toThrow();
    });

    it('rejects a candidate voting in their own election', () => {
      expect(() => policy.assertNotVotingOnOwnCandidacy(true, 'p1', ['p1', 'p2'])).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('assertEligibleToCastBallot', () => {
    it('allows a direct match', () => {
      expect(() => policy.assertEligibleToCastBallot(true, false)).not.toThrow();
    });

    it('allows a proxy match', () => {
      expect(() => policy.assertEligibleToCastBallot(false, true)).not.toThrow();
    });

    it('rejects neither a direct nor a proxy match', () => {
      expect(() => policy.assertEligibleToCastBallot(false, false)).toThrow(AuthorizationError);
    });
  });

  describe('assertClosable', () => {
    it('allows closing an ACTIVE vote', () => {
      expect(() => policy.assertClosable('ACTIVE')).not.toThrow();
    });

    it('rejects closing a DRAFT vote', () => {
      expect(() => policy.assertClosable('DRAFT')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCancellable', () => {
    it('allows cancelling a DRAFT vote', () => {
      expect(() => policy.assertCancellable('DRAFT')).not.toThrow();
    });

    it('allows cancelling an ACTIVE vote', () => {
      expect(() => policy.assertCancellable('ACTIVE')).not.toThrow();
    });

    it('rejects cancelling an already CLOSED vote', () => {
      expect(() => policy.assertCancellable('CLOSED')).toThrow(BusinessRuleViolationError);
    });

    it('rejects cancelling an already CANCELLED vote', () => {
      expect(() => policy.assertCancellable('CANCELLED')).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertValidScope', () => {
    it('allows ENTIRE_BUILDING with no companion fields', () => {
      expect(() => policy.assertValidScope({ scopeType: 'ENTIRE_BUILDING' })).not.toThrow();
    });

    it('allows BLOCK with scopeBlockId', () => {
      expect(() =>
        policy.assertValidScope({ scopeType: 'BLOCK', scopeBlockId: 'block-1' }),
      ).not.toThrow();
    });

    it('rejects BLOCK without scopeBlockId', () => {
      expect(() => policy.assertValidScope({ scopeType: 'BLOCK' })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('allows PROPERTY_TYPE with scopeUnitType', () => {
      expect(() =>
        policy.assertValidScope({ scopeType: 'PROPERTY_TYPE', scopeUnitType: 'RESIDENTIAL' }),
      ).not.toThrow();
    });

    it('rejects PROPERTY_TYPE without scopeUnitType', () => {
      expect(() => policy.assertValidScope({ scopeType: 'PROPERTY_TYPE' })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('allows SELECTED_UNITS with at least one scopeUnitIds entry', () => {
      expect(() =>
        policy.assertValidScope({ scopeType: 'SELECTED_UNITS', scopeUnitIds: ['unit-1'] }),
      ).not.toThrow();
    });

    it('rejects SELECTED_UNITS with an empty scopeUnitIds', () => {
      expect(() =>
        policy.assertValidScope({ scopeType: 'SELECTED_UNITS', scopeUnitIds: [] }),
      ).toThrow(BusinessRuleViolationError);
    });

    it('rejects a mismatched companion field (scopeBlockId set for PROPERTY_TYPE)', () => {
      expect(() =>
        policy.assertValidScope({
          scopeType: 'PROPERTY_TYPE',
          scopeUnitType: 'RESIDENTIAL',
          scopeBlockId: 'block-1',
        }),
      ).toThrow(BusinessRuleViolationError);
    });

    it('rejects scopeUnitIds set for a non-SELECTED_UNITS scope', () => {
      expect(() =>
        policy.assertValidScope({ scopeType: 'ENTIRE_BUILDING', scopeUnitIds: ['unit-1'] }),
      ).toThrow(BusinessRuleViolationError);
    });
  });
});
