import { VoteProxyService } from './vote-proxy.service';
import { VoteProxyRepository } from '../infrastructure/repositories/vote-proxy.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { VoteProxyPolicy } from '../domain/policies/vote-proxy.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  NotFoundAppError,
} from '../../../common/errors/app-error';

/**
 * Governance Hardening Phase 3 — `VoteProxyService` unit tests.
 *
 * Same gap `voting.service.spec.ts`/`meeting.service.spec.ts` close for
 * their own services (audit §50) — this service had zero unit-level
 * coverage before this pass, only the policy layer (`vote-proxy.policy
 * .spec.ts`) and the full e2e suite. `VoteProxyRepository`/
 * `BuildingRepository`/`AuditService` are fully mocked; `VoteProxyPolicy`
 * is a real, un-mocked instance.
 */
describe('VoteProxyService', () => {
  let proxies: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let service: VoteProxyService;

  const UNIT = { id: 'unit-1', buildingId: 'b1' };
  const CURRENT_PROXY = { id: 'proxy-1', unitId: 'unit-1', granterPersonId: 'granter-1' };

  beforeEach(() => {
    proxies = {
      findCurrentForUnit: jest.fn().mockResolvedValue(CURRENT_PROXY),
      grant: jest.fn().mockResolvedValue({ id: 'proxy-2' }),
      revoke: jest.fn().mockResolvedValue({ id: 'proxy-1', isCurrent: false }),
    };
    buildings = {
      findUnitById: jest.fn().mockResolvedValue(UNIT),
      getBuildingSettings: jest.fn().mockResolvedValue({ allowTenantVoting: false }),
      findLiveEligibleVoterForUnit: jest.fn().mockResolvedValue({ personId: 'granter-1' }),
      findMemberByPhone: jest
        .fn()
        .mockResolvedValue({ personId: 'candidate-1', firstName: 'Ali', lastName: 'Rezaei', fullName: null }),
      getRoles: jest.fn().mockResolvedValue(['OWNER']),
    };
    audit = { record: jest.fn() };

    service = new VoteProxyService(
      proxies as unknown as VoteProxyRepository,
      buildings as unknown as BuildingRepository,
      new VoteProxyPolicy(),
      audit as unknown as AuditService,
    );
  });

  describe('getCurrent', () => {
    it("returns the unit's current proxy", async () => {
      const result = await service.getCurrent('b1', 'unit-1');
      expect(result).toBe(CURRENT_PROXY);
    });

    it('404s when the unit belongs to another building', async () => {
      buildings.findUnitById.mockResolvedValue({ id: 'unit-1', buildingId: 'other-building' });
      await expect(service.getCurrent('b1', 'unit-1')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('lookupCandidateByPhone', () => {
    it("resolves a candidate's display name for the unit's live eligible voter", async () => {
      const result = await service.lookupCandidateByPhone('b1', 'unit-1', '+989120000000', 'granter-1');
      expect(result).toEqual({ personId: 'candidate-1', displayName: 'Ali Rezaei' });
    });

    it('rejects a caller who is not the current live eligible voter', async () => {
      await expect(
        service.lookupCandidateByPhone('b1', 'unit-1', '+989120000000', 'someone-else'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('returns null when no member matches the looked-up phone', async () => {
      buildings.findMemberByPhone.mockResolvedValue(null);
      const result = await service.lookupCandidateByPhone('b1', 'unit-1', '+989120000000', 'granter-1');
      expect(result).toBeNull();
    });

    it('rejects resolving the caller\'s own phone back to themselves', async () => {
      buildings.findMemberByPhone.mockResolvedValue({
        personId: 'granter-1',
        firstName: null,
        lastName: null,
        fullName: null,
      });
      await expect(
        service.lookupCandidateByPhone('b1', 'unit-1', '+989120000000', 'granter-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('grant', () => {
    it('grants a proxy on behalf of the current live eligible voter, and audits it', async () => {
      const result = await service.grant('b1', 'unit-1', { proxyPersonId: 'candidate-1' }, 'granter-1', 'req-1');

      expect(result).toEqual({ id: 'proxy-2' });
      expect(proxies.grant).toHaveBeenCalledWith({
        unitId: 'unit-1',
        buildingId: 'b1',
        granterPersonId: 'granter-1',
        proxyPersonId: 'candidate-1',
      });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'VoteProxyGranted' }));
    });

    it('rejects a caller who is not the current live eligible voter', async () => {
      await expect(
        service.grant('b1', 'unit-1', { proxyPersonId: 'candidate-1' }, 'someone-else', 'req-1'),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(proxies.grant).not.toHaveBeenCalled();
    });

    it('rejects appointing yourself as your own proxy', async () => {
      await expect(
        service.grant('b1', 'unit-1', { proxyPersonId: 'granter-1' }, 'granter-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(proxies.grant).not.toHaveBeenCalled();
    });

    it('rejects a proxyPersonId who is not a current member of the building', async () => {
      buildings.getRoles.mockResolvedValue([]);
      await expect(
        service.grant('b1', 'unit-1', { proxyPersonId: 'not-a-member' }, 'granter-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(proxies.grant).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('revokes the current proxy when called by the granter, and audits it', async () => {
      const result = await service.revoke('b1', 'unit-1', 'granter-1', 'req-1');

      expect(result).toEqual({ id: 'proxy-1', isCurrent: false });
      expect(proxies.revoke).toHaveBeenCalledWith('proxy-1');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'VoteProxyRevoked' }));
    });

    it('rejects revocation when there is no current proxy', async () => {
      proxies.findCurrentForUnit.mockResolvedValue(null);
      await expect(service.revoke('b1', 'unit-1', 'granter-1', 'req-1')).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
    });

    it('rejects revocation by anyone other than the original granter (e.g. the proxy holder themselves)', async () => {
      await expect(service.revoke('b1', 'unit-1', 'not-the-granter', 'req-1')).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      expect(proxies.revoke).not.toHaveBeenCalled();
    });
  });
});
