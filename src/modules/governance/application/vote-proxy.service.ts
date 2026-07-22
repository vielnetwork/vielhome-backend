import { Injectable } from '@nestjs/common';
import { VoteProxyRepository } from '../infrastructure/repositories/vote-proxy.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { VoteProxyPolicy } from '../domain/policies/vote-proxy.policy';
import { GrantVoteProxyDto } from './dto/grant-vote-proxy.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * Standing Proxy Voting (08.07 Rule 011/012 — see 21_ADRs > ADR-089).
 */
@Injectable()
export class VoteProxyService {
  constructor(
    private readonly proxies: VoteProxyRepository,
    private readonly buildings: BuildingRepository,
    private readonly policy: VoteProxyPolicy,
    private readonly audit: AuditService,
  ) {}

  private async getOwnUnit(buildingId: string, unitId: string) {
    const unit = await this.buildings.findUnitById(unitId);
    if (!unit || unit.buildingId !== buildingId) {
      throw new NotFoundAppError('Unit not found.');
    }
    return unit;
  }

  async getCurrent(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    return this.proxies.findCurrentForUnit(unitId);
  }

  /**
   * Only the unit's own LIVE eligible voter right now may appoint a proxy
   * — resolved via the same OWNER/TENANT preference
   * `VotingRepository.publishVote`'s eligibility snapshot uses, just
   * evaluated live instead of frozen at publish time (there is no vote in
   * context here — see `BuildingRepository.findLiveEligibleVoterForUnit`'s
   * own comment).
   */
  async grant(
    buildingId: string,
    unitId: string,
    dto: GrantVoteProxyDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);

    const settings = await this.buildings.getBuildingSettings(buildingId);
    const eligibleVoter = await this.buildings.findLiveEligibleVoterForUnit(
      unitId,
      settings.allowTenantVoting,
    );
    this.policy.assertCallerIsEligibleVoter(eligibleVoter?.personId === actorPersonId);

    this.policy.assertNotSelfProxy(actorPersonId, dto.proxyPersonId);

    const proxyRoles = await this.buildings.getRoles(dto.proxyPersonId, buildingId);
    this.policy.assertProxyIsMember(proxyRoles.length > 0);

    const proxy = await this.proxies.grant({
      unitId,
      buildingId,
      granterPersonId: actorPersonId,
      proxyPersonId: dto.proxyPersonId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'VoteProxyGranted',
      entityType: 'VoteProxy',
      entityId: proxy.id,
      requestId,
      metadata: { unitId, proxyPersonId: dto.proxyPersonId },
    });

    return proxy;
  }

  /**
   * Self-service only — same posture as `BuildingService.transferOwnership`:
   * only the person who granted a proxy may revoke it, not a manager and
   * not the proxy holder themselves (revoking someone else's delegation
   * out from under them is not this route's job — the granter simply
   * grants a new one, which already ends the old one atomically, see
   * `VoteProxyRepository.grant`).
   */
  async revoke(buildingId: string, unitId: string, actorPersonId: string, requestId: string) {
    await this.getOwnUnit(buildingId, unitId);

    const current = await this.proxies.findCurrentForUnit(unitId);
    this.policy.assertHasCurrentProxy(current);
    this.policy.assertCallerIsGranter(current.granterPersonId === actorPersonId);

    const revoked = await this.proxies.revoke(current.id);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'VoteProxyRevoked',
      entityType: 'VoteProxy',
      entityId: current.id,
      requestId,
      metadata: { unitId },
    });

    return revoked;
  }
}
