import { VoteProxyPolicy } from './vote-proxy.policy';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

describe('VoteProxyPolicy', () => {
  let policy: VoteProxyPolicy;

  beforeEach(() => {
    policy = new VoteProxyPolicy();
  });

  describe('assertCallerIsEligibleVoter', () => {
    it("allows the unit's live eligible voter", () => {
      expect(() => policy.assertCallerIsEligibleVoter(true)).not.toThrow();
    });

    it('rejects anyone else, including a manager', () => {
      expect(() => policy.assertCallerIsEligibleVoter(false)).toThrow(AuthorizationError);
    });
  });

  describe('assertNotSelfProxy', () => {
    it('allows appointing a different person', () => {
      expect(() => policy.assertNotSelfProxy('person-1', 'person-2')).not.toThrow();
    });

    it('rejects appointing yourself', () => {
      expect(() => policy.assertNotSelfProxy('person-1', 'person-1')).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('assertProxyIsMember', () => {
    it('allows a current member', () => {
      expect(() => policy.assertProxyIsMember(true)).not.toThrow();
    });

    it('rejects a non-member', () => {
      expect(() => policy.assertProxyIsMember(false)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCallerIsGranter', () => {
    it('allows the original granter to revoke', () => {
      expect(() => policy.assertCallerIsGranter(true)).not.toThrow();
    });

    it('rejects anyone else, including the proxy holder themselves', () => {
      expect(() => policy.assertCallerIsGranter(false)).toThrow(AuthorizationError);
    });
  });

  describe('assertHasCurrentProxy', () => {
    it('allows revocation when a current proxy exists', () => {
      expect(() =>
        policy.assertHasCurrentProxy({ id: 'proxy-1', granterPersonId: 'person-1' }),
      ).not.toThrow();
    });

    it('rejects revocation when there is nothing to revoke', () => {
      expect(() => policy.assertHasCurrentProxy(null)).toThrow(BusinessRuleViolationError);
    });
  });
});
