import { Injectable } from '@nestjs/common';
import { VoteProxyRepository } from '../infrastructure/repositories/vote-proxy.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { VoteProxyPolicy } from '../domain/policies/vote-proxy.policy';
import { GrantVoteProxyDto } from './dto/grant-vote-proxy.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * Members Lookup Hardening (Phase 4B) — combines available structured
 * name components into a single display string, falling back to the
 * deprecated `Person.fullName` column only when no structured component
 * is usable at all (schema comment: "deprecated — retained for backward
 * compatibility; no code writes this going forward," Building Setup
 * Refinement Phase 3). Pure computation, no persistence — the lookup
 * flow this backs never writes any name field.
 */
function buildDisplayName(person: {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
}): string | null {
  const structured = [person.firstName, person.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' ');
  if (structured) return structured;
  const legacy = person.fullName?.trim();
  return legacy || null;
}

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
   * Members Lookup Hardening (Phase 4B) — replaces the removed generic
   * `BuildingController` `GET :id/members/lookup` route (any current
   * member of any role could resolve any other member's identity
   * building-wide by phone) with a purpose-specific, unit-scoped lookup:
   * reachable only by THIS unit's own live eligible voter — the exact
   * same person `grant` below already requires — so an ordinary member
   * who could not actually appoint a proxy for this unit cannot use
   * lookup as a directory either. Convenience only, never the final
   * security boundary: `grant` independently re-derives and re-asserts
   * every one of these checks itself when the proxy is actually created,
   * exactly as it did before this method existed — a caller who bypassed
   * lookup entirely and posted straight to `grant` gets the same
   * protection.
   *
   * Returns `null` (not an error) both when nobody with that phone
   * currently belongs to this building AND when the caller isn't
   * eligible to look up at all would instead throw — the two are
   * deliberately different: an ineligible CALLER is rejected outright
   * (`AuthorizationError`, before any candidate resolution happens, so
   * no phone-existence side channel), while an unresolved CANDIDATE
   * phone is a normal "not found" result, mirroring `findMemberByPhone`
   * 's own established "not found is not an error" shape.
   */
  async lookupCandidateByPhone(
    buildingId: string,
    unitId: string,
    phone: string,
    actorPersonId: string,
  ): Promise<{ personId: string; displayName: string | null } | null> {
    await this.getOwnUnit(buildingId, unitId);

    const settings = await this.buildings.getBuildingSettings(buildingId);
    const eligibleVoter = await this.buildings.findLiveEligibleVoterForUnit(
      unitId,
      settings.allowTenantVoting,
    );
    this.policy.assertCallerIsEligibleVoter(eligibleVoter?.personId === actorPersonId);

    const candidate = await this.buildings.findMemberByPhone(buildingId, phone);
    if (!candidate) return null;

    // Reuses the same self-proxy guard `grant` enforces — resolving a
    // caller's own phone through lookup would just surface their own
    // identity back to them, not a usable proxy candidate.
    this.policy.assertNotSelfProxy(actorPersonId, candidate.personId);

    // No `assertProxyIsMember` call here (unlike `grant`, which takes an
    // arbitrary client-supplied `proxyPersonId`): `findMemberByPhone`
    // itself only ever resolves a CURRENT member of THIS building, so
    // membership is structurally guaranteed by the resolution path, not
    // something that needs a separate runtime check.
    return {
      personId: candidate.personId,
      displayName: buildDisplayName(candidate),
    };
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
