import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ManagerAssignmentType } from '@prisma/client';
import { BuildingRepository } from '../infrastructure/repositories/building.repository';
import { BuildingSetupPolicy } from '../domain/policies/building-setup.policy';
import { ManagerAssignmentPolicy } from '../domain/policies/manager-assignment.policy';
import { OwnershipTransferPolicy } from '../domain/policies/ownership-transfer.policy';
import { TenancyPolicy } from '../domain/policies/tenancy.policy';
import { OwnershipClaimPolicy } from '../domain/policies/ownership-claim.policy';
import {
  UnitVisibilityPolicy,
  type UnitPrivacyContext,
} from '../domain/policies/unit-visibility.policy';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { InviteOwnerDto } from './dto/invite-owner.dto';
import { InviteOwnerV2Dto } from './dto/invite-owner-v2.dto';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { CreateMembershipRequestDto } from './dto/create-membership-request.dto';
import { UpdateBuildingSettingsDto } from './dto/update-building-settings.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { UnitCreatedEvent } from '../events/unit-created.event';
import { ManagerChangedEvent } from '../events/manager-changed.event';
import { OwnershipTransferInitiatedEvent } from '../events/ownership-transferred.event';
import { TenancyCreatedEvent, TenancyEndedEvent } from '../events/tenancy.events';

@Injectable()
export class BuildingService {
  constructor(
    private readonly buildings: BuildingRepository,
    private readonly policy: BuildingSetupPolicy,
    private readonly managerPolicy: ManagerAssignmentPolicy,
    private readonly ownershipTransferPolicy: OwnershipTransferPolicy,
    private readonly tenancyPolicy: TenancyPolicy,
    private readonly ownershipClaimPolicy: OwnershipClaimPolicy,
    private readonly unitVisibility: UnitVisibilityPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async getById(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  /**
   * Response enrichment (Building Setup Refinement Phase 3, item E) — the
   * `GET /buildings/:id` shape used by the controller route, additive over
   * `getById` above (which stays unchanged and is still used internally by
   * every other method below purely for its 404-if-missing check). Adds
   * `myRoles`, computed at request time from the existing Membership table
   * — no schema column.
   *
   * Building Access Refinement Phase 4 (Privacy / Data Visibility) — the
   * embedded `building.units` array (from `getById`'s own `include:
   * { units: true }`) is the SAME raw-Unit leak `listUnits` had, just
   * reachable through a different route; `shapeUnitsForCaller` below
   * redacts it identically before it's returned here.
   */
  async getBuildingForPerson(buildingId: string, personId: string) {
    const building = await this.getById(buildingId);
    const myRoles = await this.buildings.getRoles(personId, buildingId);
    const units = await this.shapeUnitsForCaller(building.units, buildingId, personId, myRoles);
    return { ...building, units, myRoles };
  }

  /**
   * Building Access Refinement Phase 4 (Privacy / Data Visibility) —
   * shared by `getBuildingForPerson` (embedded `building.units`) and
   * `listUnits` below, so both surfaces redact identically from one
   * implementation rather than two. Batched (one query per helper for the
   * WHOLE `units` array, not one per unit) — see each `BuildingRepository`
   * method's own doc comment.
   */
  private async shapeUnitsForCaller(
    units: Array<Record<string, unknown> & { id: string; ownerPhone: string | null }>,
    buildingId: string,
    personId: string,
    roles: string[],
  ) {
    const [ownedUnitIds, tenantUnitIds, unitIdsWithOwnership, caller] = await Promise.all([
      this.buildings.findCurrentOwnedUnitIdsForPerson(buildingId, personId),
      this.buildings.findCurrentTenantUnitIdsForPerson(buildingId, personId),
      this.buildings.findUnitIdsWithCurrentOwnership(buildingId),
      this.buildings.findPersonById(personId),
    ]);

    const unitIds = units.map((u) => u.id);
    const [currentOwners, currentTenants] = await Promise.all([
      this.buildings.findCurrentOwnerSummariesForUnits(unitIds),
      this.buildings.findCurrentTenantSummariesForUnits(unitIds),
    ]);

    const isManager = roles.includes('MANAGER');

    return units.map((unit) => {
      const isCurrentOwnerOfUnit = ownedUnitIds.has(unit.id);
      const isCurrentTenantOfUnit = tenantUnitIds.has(unit.id);
      // Same eligibility rule `canClaimOwnership`/`OwnershipClaimPolicy.
      // assertEligible` use, batched: no current owner yet, and the
      // unit's pending `ownerPhone` matches the caller's own
      // server-verified phone.
      const isInvitedOwnerCandidate =
        !isCurrentOwnerOfUnit &&
        !unitIdsWithOwnership.has(unit.id) &&
        !!unit.ownerPhone &&
        !!caller?.phone &&
        unit.ownerPhone === caller.phone;

      const ctx: UnitPrivacyContext = {
        isManager,
        isCurrentOwnerOfUnit,
        isCurrentTenantOfUnit,
        isInvitedOwnerCandidate,
      };

      return this.unitVisibility.shapeUnit(
        unit,
        ctx,
        currentOwners.get(unit.id) ?? null,
        currentTenants.get(unit.id) ?? null,
      );
    });
  }

  listForPerson(personId: string) {
    return this.buildings.listForPerson(personId);
  }

  /**
   * Response enrichment (Building Setup Refinement Phase 3, item E) — the
   * `GET /buildings` shape used by the controller route. Batches one
   * `getRolesForBuildings` call instead of N+1 `getRoles` calls. Not folded
   * into the plain `listForPerson` above since `AuthService.verifyOtp`
   * calls that one too, only to check `.length > 0` — no need to pay for
   * role enrichment there.
   */
  async listForPersonEnriched(personId: string) {
    const buildings = await this.buildings.listForPerson(personId);
    const rolesByBuilding = await this.buildings.getRolesForBuildings(
      personId,
      buildings.map((b) => b.id),
    );
    return buildings.map((b) => ({ ...b, myRoles: rolesByBuilding[b.id] ?? [] }));
  }

  /**
   * Called from AuthService on every OTP verify (both new and returning
   * persons — see AuthService.verifyOtp). Links any skeleton units whose
   * owner-invite phone number matches this person's phone: creates the
   * Ownership + OWNER Membership so the person lands straight on their
   * building's dashboard instead of the empty-state "register a building"
   * wizard. Safe to call every login — findUnlinkedOwnerUnitsByPhone only
   * ever returns units that aren't linked yet.
   *
   * Members Lookup Hardening (Phase 4B follow-up) — now passes the pending
   * invite's structured `ownerFirstName`/`ownerLastName` through to
   * `linkOwnerToUnit`'s own `pendingOwnerFirstName`/`pendingOwnerLastName`
   * params, exactly the way `claimOwnership` already does for the Owner
   * Self-Claim path. Previously this never passed them at all, so an
   * owner who only ever auto-linked via OTP verify (never self-claimed)
   * kept a permanently-null `Person.firstName`/`lastName` even after a
   * real `invite-owner/v2` invite — a pre-existing gap between these two
   * owner-linking paths, not something this phase's own vote-proxy
   * display-name work introduced, but surfaced by it (nothing previously
   * read an auto-linked owner's name back in an assertion). Safe by
   * construction: `fillMissingPersonName` (called inside `linkOwnerToUnit`)
   * only ever fills a currently-null field, never overwrites a name the
   * person already set themselves.
   */
  async linkOwnerAccountByPhone(
    personId: string,
    phone: string,
    requestId: string,
  ): Promise<string[]> {
    const units = await this.buildings.findUnlinkedOwnerUnitsByPhone(phone);
    const linkedBuildingIds: string[] = [];

    for (const unit of units) {
      await this.buildings.linkOwnerToUnit({
        unitId: unit.id,
        buildingId: unit.buildingId,
        personId,
        pendingOwnerFirstName: unit.ownerFirstName,
        pendingOwnerLastName: unit.ownerLastName,
      });
      linkedBuildingIds.push(unit.buildingId);

      await this.audit.record({
        actorId: personId,
        buildingId: unit.buildingId,
        action: 'OwnerAutoLinked',
        entityType: 'Unit',
        entityId: unit.id,
        requestId,
        metadata: { phone },
      });
    }

    return linkedBuildingIds;
  }

  async addUnit(buildingId: string, personId: string, dto: CreateUnitDto, requestId: string) {
    await this.getById(buildingId); // 404s if the building doesn't exist

    const existingUnits = await this.buildings.listUnits(buildingId);
    this.policy.assertUniqueUnitNumber(
      existingUnits.map((u) => u.unitNumber),
      dto.unitNumber,
    );

    const unit = await this.buildings.createUnit({
      buildingId,
      blockId: dto.blockId,
      floorId: dto.floorId,
      unitNumber: dto.unitNumber,
      type: dto.type,
      areaSqm: dto.areaSqm,
    });

    await this.audit.record({
      actorId: personId,
      buildingId,
      action: 'UnitCreated',
      entityType: 'Unit',
      entityId: unit.id,
      requestId,
    });

    this.events.emit('UnitCreated', new UnitCreatedEvent(unit.id, buildingId, personId));

    return unit;
  }

  /**
   * Building Access Refinement Phase 4 (Privacy / Data Visibility) — was a
   * raw passthrough of `BuildingRepository.listUnits` (every unit's
   * pending-owner identity fields, leaked to any current building
   * member regardless of role/unit). Now routes through the same
   * `shapeUnitsForCaller` helper `getBuildingForPerson` uses, so both
   * surfaces redact identically.
   */
  async listUnits(buildingId: string, personId: string) {
    const [units, roles] = await Promise.all([
      this.buildings.listUnits(buildingId),
      this.buildings.getRoles(personId, buildingId),
    ]);
    return this.shapeUnitsForCaller(units, buildingId, personId, roles);
  }

  private async getOwnUnit(buildingId: string, unitId: string) {
    await this.getById(buildingId); // 404s if the building doesn't exist
    const unit = await this.buildings.findUnitById(unitId);
    if (!unit || unit.buildingId !== buildingId) {
      throw new NotFoundAppError('Unit not found.');
    }
    return unit;
  }

  getUnit(buildingId: string, unitId: string) {
    return this.getOwnUnit(buildingId, unitId);
  }

  /**
   * Response enrichment (Building Setup Refinement Phase 3, item E) — the
   * `GET /buildings/:id/units/:unitId` shape used by the controller route.
   * `isCurrentOwner`/`isCurrentTenant` are simple existence checks against
   * Ownership/Tenancy; `canClaimOwnership` is the ONLY signal Mobile is
   * allowed to use to decide whether to show the self-claim CTA — it must
   * never compare `ownerPhone` against its own phone itself. Computed
   * exclusively from: this unit has no current Ownership, the caller isn't
   * already the current owner, and `Unit.ownerPhone` matches the caller's
   * own server-side `Person.phone` — the identical eligibility rule
   * `OwnershipClaimPolicy.assertEligible` enforces at claim time, just
   * previewed here read-only.
   */
  async getUnitForPerson(buildingId: string, unitId: string, personId: string) {
    const unit = await this.getOwnUnit(buildingId, unitId);
    const [isCurrentOwner, currentTenancy, hasCurrentOwnership, caller, roles, currentOwnerSummary, currentTenantSummary] =
      await Promise.all([
        this.buildings.isCurrentOwnerOfUnit(unitId, personId),
        this.buildings.findCurrentTenancyForUnit(unitId),
        this.buildings.hasCurrentOwnership(unitId),
        this.buildings.findPersonById(personId),
        this.buildings.getRoles(personId, buildingId),
        this.buildings.findCurrentOwnerSummaryForUnit(unitId),
        this.buildings.findCurrentTenantSummaryForUnit(unitId),
      ]);

    const isCurrentTenant = currentTenancy?.personId === personId;
    const canClaimOwnership =
      !isCurrentOwner &&
      !hasCurrentOwnership &&
      !!unit.ownerPhone &&
      !!caller?.phone &&
      unit.ownerPhone === caller.phone;

    // Building Access Refinement Phase 4 (Privacy / Data Visibility) —
    // `canClaimOwnership` doubles as `isInvitedOwnerCandidate`: both mean
    // exactly "no current Ownership yet, and Unit.ownerPhone matches the
    // caller's own verified phone" (the same rule `UnitDetailAccessGuard`
    // itself enforces to let this caller reach this unit at all when
    // they're not yet a building member).
    const ctx: UnitPrivacyContext = {
      isManager: roles.includes('MANAGER'),
      isCurrentOwnerOfUnit: isCurrentOwner,
      isCurrentTenantOfUnit: isCurrentTenant,
      isInvitedOwnerCandidate: canClaimOwnership,
    };

    const shaped = this.unitVisibility.shapeUnit(unit, ctx, currentOwnerSummary, currentTenantSummary);
    return { ...shaped, isCurrentOwner, isCurrentTenant, canClaimOwnership };
  }

  /**
   * Owner Self-Claim (Building Setup Refinement Phase 3) — "trigger the
   * same Ownership+Membership link `linkOwnerAccountByPhone` would
   * otherwise only apply on this person's next OTP verify, right now."
   * Empty request body by design: identity comes exclusively from
   * `req.user.sub` -> this method's own `personId` param -> the caller's
   * own server-verified `Person.phone`, never from anything the client
   * submits. No `MembershipGuard`/`RolesGuard` on this route (see the
   * controller) — the caller may not be a member of this unit/building at
   * all yet, same precedent as `requestMembership`.
   */
  async claimOwnership(buildingId: string, unitId: string, personId: string, requestId: string) {
    const unit = await this.getOwnUnit(buildingId, unitId);
    const [hasCurrentOwnership, caller] = await Promise.all([
      this.buildings.hasCurrentOwnership(unitId),
      this.buildings.findPersonById(personId),
    ]);
    if (!caller) throw new NotFoundAppError('Person not found.');

    this.ownershipClaimPolicy.assertEligible({
      hasCurrentOwnership,
      unitOwnerPhone: unit.ownerPhone,
      callerPhone: caller.phone,
    });

    const membership = await this.buildings.linkOwnerToUnit({
      unitId,
      buildingId,
      personId,
      pendingOwnerFirstName: unit.ownerFirstName,
      pendingOwnerLastName: unit.ownerLastName,
    });

    await this.audit.record({
      actorId: personId,
      buildingId,
      action: 'OwnerSelfClaimed',
      entityType: 'Unit',
      entityId: unitId,
      requestId,
    });

    return membership;
  }

  /** "Configure Units" — fills in a skeleton unit's details after the fact. */
  async updateUnit(
    buildingId: string,
    unitId: string,
    dto: UpdateUnitDto,
    personId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);
    const updated = await this.buildings.updateUnit(unitId, dto);

    await this.audit.record({
      actorId: personId,
      buildingId,
      action: 'UnitUpdated',
      entityType: 'Unit',
      entityId: unitId,
      requestId,
    });

    return updated;
  }

  /**
   * Sends an owner invite for a unit. No SMS gateway exists yet (same gap
   * as OTP) so the "send" is console-logged, not a real message. This does
   * NOT auto-link the invited phone number to a Person/Membership when
   * they eventually sign up — that reconciliation is a follow-up, not
   * built here; today it only records that an invite was sent.
   */
  async inviteOwner(
    buildingId: string,
    unitId: string,
    dto: InviteOwnerDto,
    personId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);
    await this.buildings.updateUnit(unitId, {
      ownerFullName: dto.ownerFullName,
      ownerPhone: dto.ownerPhone,
    });

    // eslint-disable-next-line no-console
    console.log(`[UnitOwnerInvite] ${dto.ownerPhone} (${dto.ownerFullName}) -> unit ${unitId}`);

    const updated = await this.buildings.markOwnerInviteSent(unitId);

    await this.audit.record({
      actorId: personId,
      buildingId,
      action: 'UnitOwnerInvited',
      entityType: 'Unit',
      entityId: unitId,
      requestId,
      metadata: { ownerPhone: dto.ownerPhone },
    });

    return updated;
  }

  /**
   * Additive sibling of `inviteOwner` above (Building Setup Refinement
   * Phase 3) — the frozen `invite-owner` route/DTO stays untouched; this
   * backs the new `invite-owner/v2` route. Stores `ownerFirstName`/
   * `ownerLastName` as the canonical pending-invite fields, per the
   * approved product decision that Owner identity must be discrete fields
   * going forward. Also writes a computed `ownerFullName` (`firstName +
   * " " + lastName`) so anything still reading the legacy field (e.g. the
   * mobile Unit Edit screen's current display) keeps working without
   * needing to change in lockstep with this endpoint.
   */
  async inviteOwnerV2(
    buildingId: string,
    unitId: string,
    dto: InviteOwnerV2Dto,
    personId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);
    await this.buildings.updateUnit(unitId, {
      ownerFirstName: dto.ownerFirstName,
      ownerLastName: dto.ownerLastName,
      ownerFullName: `${dto.ownerFirstName} ${dto.ownerLastName}`,
      ownerPhone: dto.ownerPhone,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[UnitOwnerInvite] ${dto.ownerPhone} (${dto.ownerFirstName} ${dto.ownerLastName}) -> unit ${unitId}`,
    );

    const updated = await this.buildings.markOwnerInviteSent(unitId);

    await this.audit.record({
      actorId: personId,
      buildingId,
      action: 'UnitOwnerInvited',
      entityType: 'Unit',
      entityId: unitId,
      requestId,
      metadata: { ownerPhone: dto.ownerPhone },
    });

    return updated;
  }

  /**
   * The escape hatch for the postal-code duplicate check
   * (BuildingSetupPolicy.assertPostalCodeAvailable): request to join an
   * already-registered building instead of being blocked outright.
   */
  async requestMembership(
    buildingId: string,
    personId: string,
    dto: CreateMembershipRequestDto,
    requestId: string,
  ) {
    await this.getById(buildingId); // 404s if the building doesn't exist

    const request = await this.buildings.createMembershipRequest({
      buildingId,
      personId,
      role: dto.role,
      message: dto.message,
    });

    // eslint-disable-next-line no-console
    console.log(`[MembershipRequest] person=${personId} building=${buildingId} role=${dto.role}`);

    await this.audit.record({
      actorId: personId,
      buildingId,
      action: 'MembershipRequested',
      entityType: 'MembershipRequest',
      entityId: request.id,
      requestId,
    });

    return request;
  }

  /**
   * No review UI exists on mobile yet (fast-follow, same pattern as the
   * SMS gateway stub) — an existing manager/owner can list and resolve
   * requests via these two methods/endpoints directly for now.
   */
  listMembershipRequests(buildingId: string) {
    return this.buildings.listMembershipRequests(buildingId);
  }

  async resolveMembershipRequest(
    buildingId: string,
    requestId2: string,
    status: 'APPROVED' | 'REJECTED',
    actorPersonId: string,
    requestId: string,
  ) {
    const request = await this.buildings.findMembershipRequestById(requestId2);
    if (!request || request.buildingId !== buildingId) {
      throw new NotFoundAppError('Membership request not found.');
    }

    const updated = await this.buildings.updateMembershipRequestStatus(requestId2, status);

    if (status === 'APPROVED') {
      if (request.role === 'MANAGER') {
        // Rule 001 (10.07.04): only one active manager at a time. Approving
        // a MANAGER-role request must not silently displace whoever is
        // currently managing — that's an explicit handoff, via
        // `changeManager`, not something that falls out of a membership
        // approval.
        const existing = await this.buildings.getCurrentManagerMembership(buildingId);
        this.managerPolicy.assertNoActiveManager(existing);
      }
      await this.buildings.createMembership({
        personId: request.personId,
        buildingId,
        role: request.role,
      });
    }

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: status === 'APPROVED' ? 'MembershipRequestApproved' : 'MembershipRequestRejected',
      entityType: 'MembershipRequest',
      entityId: requestId2,
      requestId,
    });

    return updated;
  }

  // --- Manager Assignment (21_ADRs > ADR-022) -----------------------------

  getCurrentManager(buildingId: string) {
    return this.buildings.getCurrentManagerMembership(buildingId);
  }

  getManagementHistory(buildingId: string) {
    return this.buildings.listManagementHistory(buildingId);
  }

  /**
   * Explicit manager handoff. Restricted to the current MANAGER
   * (`RolesGuard` on the controller route) — Elections and BackOffice
   * assignment are future entry points into this same method once those
   * domains exist, not built here (10.07.04: "Election Results May Assign
   * Managers", "BackOffice May Assign Temporary Managers").
   */
  async changeManager(
    buildingId: string,
    newManagerPersonId: string,
    assignmentType: ManagerAssignmentType,
    // Optional: `VotingService.closeVote`'s scheduler-driven manager
    // election handoff (21_ADRs > ADR-036) calls this with no staff actor.
    actorPersonId: string | undefined,
    requestId: string,
  ) {
    await this.getById(buildingId); // 404s if the building doesn't exist

    const current = await this.buildings.getCurrentManagerMembership(buildingId);
    this.managerPolicy.assertNotSelfHandoff(current?.personId, newManagerPersonId);

    const candidateRoles = await this.buildings.getRoles(newManagerPersonId, buildingId);
    this.managerPolicy.assertCandidateIsMember(candidateRoles.length > 0);

    const created = await this.buildings.changeManager({
      buildingId,
      newManagerPersonId,
      assignmentType,
      assignedById: actorPersonId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ManagerChanged',
      entityType: 'Membership',
      entityId: created.id,
      requestId,
      metadata: {
        newManagerPersonId,
        previousManagerPersonId: current?.personId ?? null,
        assignmentType,
      },
    });

    this.events.emit(
      'ManagerChanged',
      new ManagerChangedEvent(
        buildingId,
        newManagerPersonId,
        current?.personId ?? null,
        actorPersonId,
      ),
    );

    return created;
  }

  /**
   * Ends the active management period without assigning a successor —
   * the building is left without a manager (Recovery Mode from
   * 06.03_Manager_Verification_Flow is a future BackOffice concern, not
   * built here; today this just records the fact honestly rather than
   * pretending a successor exists).
   */
  async endManagement(buildingId: string, actorPersonId: string, requestId: string) {
    const current = await this.buildings.getCurrentManagerMembership(buildingId);
    this.managerPolicy.assertHasActiveManager(current);

    const updated = await this.buildings.endManagement(current.id);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ManagementEnded',
      entityType: 'Membership',
      entityId: current.id,
      requestId,
    });

    return updated;
  }

  // --- Ownership Transfer (10.07.02 — see 21_ADRs > ADR-035) ---------------

  /**
   * Building Access Refinement Phase 4 (Privacy / Data Visibility) —
   * shared unit-scoped history-access context: MANAGER, or this specific
   * unit's own current Owner/Tenant, may reach the ownership/tenancy
   * history endpoints and the single current-tenancy read; anyone else
   * (an unrelated OWNER/TENANT of a different unit, or a BOARD_MEMBER/
   * ACCOUNTANT with no unit-specific relationship) is denied outright by
   * `UnitVisibilityPolicy.assertCanAccessUnitHistory`. `isInvitedOwner
   * Candidate` is irrelevant to history access (an unclaimed unit's
   * invited-but-not-yet-claimed owner must NOT gain ownership/tenancy
   * history per the Phase 4 decision) so it's always `false` here.
   */
  private async buildHistoryAccessContext(
    buildingId: string,
    unitId: string,
    personId: string,
  ): Promise<UnitPrivacyContext> {
    const [roles, isCurrentOwnerOfUnit, currentTenancy] = await Promise.all([
      this.buildings.getRoles(personId, buildingId),
      this.buildings.isCurrentOwnerOfUnit(unitId, personId),
      this.buildings.findCurrentTenancyForUnit(unitId),
    ]);
    return {
      isManager: roles.includes('MANAGER'),
      isCurrentOwnerOfUnit,
      isCurrentTenantOfUnit: currentTenancy?.personId === personId,
      isInvitedOwnerCandidate: false,
    };
  }

  async getOwnershipHistory(buildingId: string, unitId: string, personId: string) {
    await this.getOwnUnit(buildingId, unitId); // 404s if the unit/building don't match
    const ctx = await this.buildHistoryAccessContext(buildingId, unitId, personId);
    this.unitVisibility.assertCanAccessUnitHistory(ctx);
    const history = await this.buildings.listOwnershipHistoryForUnit(unitId);
    return history.map((entry) => this.unitVisibility.shapeHistoryEntry(entry, ctx, personId));
  }

  /**
   * Self-service: only the unit's own current owner may initiate (10.07.01
   * _Manager_User_Flow — a manager "cannot change legal ownership
   * directly"). Ends the current Ownership/OWNER-Membership rows and
   * repoints `Unit.ownerPhone` at the incoming owner; the transfer
   * completes automatically the next time that phone number verifies OTP,
   * via the already-shipped `linkOwnerToUnit` auto-link path — see
   * `BuildingRepository.transferOwnership`'s own comment.
   */
  async transferOwnership(
    buildingId: string,
    unitId: string,
    newOwnerPhone: string,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);

    const isOwner = await this.buildings.isCurrentOwnerOfUnit(unitId, actorPersonId);
    this.ownershipTransferPolicy.assertCallerIsCurrentOwner(isOwner);

    const updated = await this.buildings.transferOwnership({ unitId, newOwnerPhone });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'OwnershipTransferInitiated',
      entityType: 'Unit',
      entityId: unitId,
      requestId,
      metadata: { newOwnerPhone },
    });

    this.events.emit(
      'OwnershipTransferInitiated',
      new OwnershipTransferInitiatedEvent(unitId, buildingId, actorPersonId, newOwnerPhone),
    );

    return updated;
  }

  // --- Tenancy (10.07.03 — see 21_ADRs > ADR-035) ---------------------------

  async getCurrentTenancy(buildingId: string, unitId: string, personId: string) {
    await this.getOwnUnit(buildingId, unitId); // 404s if the unit/building don't match
    const [roles, isCurrentOwnerOfUnit, tenancy] = await Promise.all([
      this.buildings.getRoles(personId, buildingId),
      this.buildings.isCurrentOwnerOfUnit(unitId, personId),
      this.buildings.findCurrentTenancyForUnit(unitId),
    ]);
    const ctx: UnitPrivacyContext = {
      isManager: roles.includes('MANAGER'),
      isCurrentOwnerOfUnit,
      isCurrentTenantOfUnit: tenancy?.personId === personId,
      isInvitedOwnerCandidate: false,
    };
    this.unitVisibility.assertCanAccessUnitHistory(ctx);
    if (!tenancy) return null;
    return this.unitVisibility.shapeHistoryEntry(tenancy, ctx, personId);
  }

  async getTenancyHistory(buildingId: string, unitId: string, personId: string) {
    await this.getOwnUnit(buildingId, unitId); // 404s if the unit/building don't match
    const ctx = await this.buildHistoryAccessContext(buildingId, unitId, personId);
    this.unitVisibility.assertCanAccessUnitHistory(ctx);
    const history = await this.buildings.listTenanciesForUnit(unitId);
    return history.map((entry) => this.unitVisibility.shapeHistoryEntry(entry, ctx, personId));
  }

  private async assertManagesUnit(
    buildingId: string,
    unitId: string,
    actorPersonId: string,
    requireOwnerOrManagerOnly: boolean,
    tenantPersonId?: string,
  ) {
    const [isOwner, roles] = await Promise.all([
      this.buildings.isCurrentOwnerOfUnit(unitId, actorPersonId),
      this.buildings.getRoles(actorPersonId, buildingId),
    ]);
    const isManager = roles.includes('MANAGER');

    if (requireOwnerOrManagerOnly) {
      this.tenancyPolicy.assertCanCreate(isOwner, isManager);
    } else {
      this.tenancyPolicy.assertCanManage(isOwner, isManager, tenantPersonId === actorPersonId);
    }
  }

  /** Rule 003 — only one active tenancy per unit; only the unit's owner or the building's manager may register one (04.02 Rule 27/29). */
  async createTenancy(
    buildingId: string,
    unitId: string,
    tenantPersonId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);
    await this.assertManagesUnit(buildingId, unitId, actorPersonId, true);

    // Product Rule 2 (Building Setup Refinement Phase 3) — a tenant-occupied
    // unit must have a registered Owner. Checked here so BOTH tenancy-
    // creation paths (this legacy `tenantPersonId` route and the new
    // `tenancy/register` phone-based route below, which delegates straight
    // into this same method) share one enforcement point.
    const hasOwner = await this.buildings.hasCurrentOwnership(unitId);
    this.tenancyPolicy.assertUnitHasOwner(hasOwner);

    const existing = await this.buildings.findCurrentTenancyForUnit(unitId);
    this.tenancyPolicy.assertUnitAvailableForTenancy(existing);

    const tenancy = await this.buildings.createTenancy({
      unitId,
      buildingId,
      personId: tenantPersonId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'TenancyCreated',
      entityType: 'Tenancy',
      entityId: tenancy.id,
      requestId,
      metadata: { unitId, tenantPersonId },
    });

    this.events.emit(
      'TenancyCreated',
      new TenancyCreatedEvent(tenancy.id, unitId, buildingId, tenantPersonId),
    );

    return tenancy;
  }

  /**
   * Building Setup Refinement Phase 3 — additive sibling of `createTenancy`
   * above, backing the new `tenancy/register` route. Mobile never sends a
   * `tenantPersonId`; it collects a name + phone, exactly like an owner
   * invite. Resolves (or creates) the Person from `dto.tenantPhone` under
   * the approved identity-ownership rule — an existing Person's own
   * non-null `firstName`/`lastName` is never overwritten, only missing
   * fields are filled — then delegates straight into the existing,
   * unchanged `createTenancy` (so the owner-required gate above and every
   * other check run exactly once, for both tenancy-creation paths).
   */
  async registerTenant(
    buildingId: string,
    unitId: string,
    dto: RegisterTenantDto,
    actorPersonId: string,
    requestId: string,
  ) {
    let person = await this.buildings.findPersonByPhone(dto.tenantPhone);
    if (!person) {
      person = await this.buildings.createPersonWithName({
        phone: dto.tenantPhone,
        firstName: dto.tenantFirstName,
        lastName: dto.tenantLastName,
      });
    } else {
      await this.buildings.fillMissingPersonName(person.id, dto.tenantFirstName, dto.tenantLastName);
    }

    return this.createTenancy(buildingId, unitId, person.id, actorPersonId, requestId);
  }

  private async getOwnTenancy(buildingId: string, tenancyId: string) {
    const tenancy = await this.buildings.findTenancyById(tenancyId);
    if (!tenancy) throw new NotFoundAppError('Tenancy not found.');
    await this.getOwnUnit(buildingId, tenancy.unitId); // 404s if the unit/building don't match
    return tenancy;
  }

  async giveTenancyNotice(
    buildingId: string,
    tenancyId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const tenancy = await this.getOwnTenancy(buildingId, tenancyId);
    await this.assertManagesUnit(
      buildingId,
      tenancy.unitId,
      actorPersonId,
      false,
      tenancy.personId,
    );
    this.tenancyPolicy.assertCanGiveNotice(tenancy.status);

    const updated = await this.buildings.giveTenancyNotice(tenancyId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'TenancyNoticeGiven',
      entityType: 'Tenancy',
      entityId: tenancyId,
      requestId,
    });

    return updated;
  }

  async endTenancy(
    buildingId: string,
    tenancyId: string,
    terminationReason: string | undefined,
    actorPersonId: string,
    requestId: string,
  ) {
    const tenancy = await this.getOwnTenancy(buildingId, tenancyId);
    await this.assertManagesUnit(
      buildingId,
      tenancy.unitId,
      actorPersonId,
      false,
      tenancy.personId,
    );
    this.tenancyPolicy.assertCanEnd(tenancy.status);

    const updated = await this.buildings.endTenancy({
      id: tenancyId,
      unitId: tenancy.unitId,
      personId: tenancy.personId,
      terminationReason,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'TenancyEnded',
      entityType: 'Tenancy',
      entityId: tenancyId,
      requestId,
      reason: terminationReason,
    });

    this.events.emit(
      'TenancyEnded',
      new TenancyEndedEvent(tenancyId, tenancy.unitId, buildingId, tenancy.personId),
    );

    return updated;
  }

  // --- Building Settings/Policy domain (21_ADRs > ADR-089) ------------------

  /** Any current member may read a building's settings — the toggle affects how their own vote gets counted. */
  async getSettings(buildingId: string) {
    await this.getById(buildingId); // 404s if the building doesn't exist
    return this.buildings.getBuildingSettings(buildingId);
  }

  /**
   * Restricted to OWNER/MANAGER (`RolesGuard` on the controller route) —
   * the same building-policy-level authority `resolveMembershipRequest`
   * above already uses, not `VerifiedRolesGuard`: no source rule makes
   * the "must be a VERIFIED manager" claim for this specific action the
   * way ADR-038 made it for Governance's own create/publish/close/cancel
   * routes, and inventing one here would be exactly the kind of
   * unsupported rule this project's ADR series has consistently declined
   * to add.
   */
  async updateSettings(
    buildingId: string,
    dto: UpdateBuildingSettingsDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getById(buildingId); // 404s if the building doesn't exist

    const updated = await this.buildings.upsertBuildingSettings(buildingId, {
      allowTenantVoting: dto.allowTenantVoting,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'BuildingSettingsUpdated',
      entityType: 'BuildingSettings',
      entityId: buildingId,
      requestId,
      metadata: { allowTenantVoting: updated.allowTenantVoting },
    });

    return updated;
  }

  // Members Lookup Hardening (Phase 4B) — `lookupMemberByPhone` (the
  // unrestricted wrapper this generic route used) was removed along with
  // `BuildingController`'s `GET :id/members/lookup` route itself; see
  // that controller's own comment. `BuildingRepository.findMemberByPhone`
  // stays — `VoteProxyService.lookupCandidateByPhone` (Governance) now
  // calls it directly, with its own unit-scoped eligibility gate in
  // front of it instead of this building-wide, any-role wrapper.
}
