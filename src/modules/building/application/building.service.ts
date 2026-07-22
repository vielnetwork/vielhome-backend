import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ManagerAssignmentType } from '@prisma/client';
import { BuildingRepository } from '../infrastructure/repositories/building.repository';
import { BuildingSetupPolicy } from '../domain/policies/building-setup.policy';
import { ManagerAssignmentPolicy } from '../domain/policies/manager-assignment.policy';
import { OwnershipTransferPolicy } from '../domain/policies/ownership-transfer.policy';
import { TenancyPolicy } from '../domain/policies/tenancy.policy';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { InviteOwnerDto } from './dto/invite-owner.dto';
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
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async getById(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  listForPerson(personId: string) {
    return this.buildings.listForPerson(personId);
  }

  /**
   * Called from AuthService on every OTP verify (both new and returning
   * persons — see AuthService.verifyOtp). Links any skeleton units whose
   * owner-invite phone number matches this person's phone: creates the
   * Ownership + OWNER Membership so the person lands straight on their
   * building's dashboard instead of the empty-state "register a building"
   * wizard. Safe to call every login — findUnlinkedOwnerUnitsByPhone only
   * ever returns units that aren't linked yet.
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

  listUnits(buildingId: string) {
    return this.buildings.listUnits(buildingId);
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

  async getOwnershipHistory(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId); // 404s if the unit/building don't match
    return this.buildings.listOwnershipHistoryForUnit(unitId);
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

  async getCurrentTenancy(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId); // 404s if the unit/building don't match
    return this.buildings.findCurrentTenancyForUnit(unitId);
  }

  async getTenancyHistory(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId); // 404s if the unit/building don't match
    return this.buildings.listTenanciesForUnit(unitId);
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
}
