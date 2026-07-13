import { MeetingPolicy } from './meeting.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('MeetingPolicy', () => {
  let policy: MeetingPolicy;

  beforeEach(() => {
    policy = new MeetingPolicy();
  });

  describe('assertNotArchived', () => {
    it('throws for an archived meeting', () => {
      expect(() => policy.assertNotArchived(new Date())).toThrow(BusinessRuleViolationError);
    });

    it('allows an active meeting', () => {
      expect(() => policy.assertNotArchived(null)).not.toThrow();
    });
  });

  describe('assertArchivable', () => {
    it('throws if already archived', () => {
      expect(() => policy.assertArchivable(new Date())).toThrow(BusinessRuleViolationError);
    });

    it('allows archiving an active meeting', () => {
      expect(() => policy.assertArchivable(null)).not.toThrow();
    });
  });
});
