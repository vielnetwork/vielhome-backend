import { TenancyPolicy } from './tenancy.policy';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('TenancyPolicy', () => {
  const policy = new TenancyPolicy();

  describe('assertUnitAvailableForTenancy', () => {
    it('allows creating a tenancy when none is active', () => {
      expect(() => policy.assertUnitAvailableForTenancy(null)).not.toThrow();
    });

    it('refuses a second active tenancy on the same unit', () => {
      expect(() => policy.assertUnitAvailableForTenancy({ id: 'tenancy-1' })).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanCreate', () => {
    it('allows the current owner', () => {
      expect(() => policy.assertCanCreate(true, false)).not.toThrow();
    });

    it('allows the manager', () => {
      expect(() => policy.assertCanCreate(false, true)).not.toThrow();
    });

    it('refuses anyone else', () => {
      expect(() => policy.assertCanCreate(false, false)).toThrow(AuthorizationError);
    });
  });

  describe('assertCanManage', () => {
    it('allows the owner, manager, or the tenant themselves', () => {
      expect(() => policy.assertCanManage(true, false, false)).not.toThrow();
      expect(() => policy.assertCanManage(false, true, false)).not.toThrow();
      expect(() => policy.assertCanManage(false, false, true)).not.toThrow();
    });

    it('refuses an unrelated member', () => {
      expect(() => policy.assertCanManage(false, false, false)).toThrow(AuthorizationError);
    });
  });

  describe('assertCanGiveNotice', () => {
    it('allows giving notice on an ACTIVE tenancy', () => {
      expect(() => policy.assertCanGiveNotice('ACTIVE')).not.toThrow();
    });

    it.each(['NOTICE_GIVEN', 'ENDED'] as const)('refuses giving notice on a %s tenancy', (status) => {
      expect(() => policy.assertCanGiveNotice(status)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCanEnd', () => {
    it.each(['ACTIVE', 'NOTICE_GIVEN'] as const)('allows ending a %s tenancy', (status) => {
      expect(() => policy.assertCanEnd(status)).not.toThrow();
    });

    it('refuses ending an already-ENDED tenancy', () => {
      expect(() => policy.assertCanEnd('ENDED')).toThrow(BusinessRuleViolationError);
    });
  });
});
