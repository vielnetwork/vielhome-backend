import { Injectable } from '@nestjs/common';
import {
  BuildingStatus,
  BuildingType,
  ManagerAssignmentType,
  MembershipRequestStatus,
  MembershipRole,
  UnitOccupancyStatus,
  UnitType,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

@Injectable()
export class BuildingRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.building.findUnique({
      where: { id },
      include: { blocks: true, units: true },
    });
  }

  listForPerson(personId: string) {
    return this.prisma.building.findMany({
      where: { memberships: { some: { personId, isCurrent: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Used by MembershipGuard — the actual "is this person allowed here" check. */
  async hasMembership(personId: string, buildingId: string): Promise<boolean> {
    const count = await this.prisma.membership.count({
      where: { personId, buildingId, isCurrent: true },
    });
    return count > 0;
  }

  /**
   * Duplicate-detection lookup (BuildingSetupPolicy.assertPostalCodeAvailable).
   * Only returns the fields the client is allowed to see about someone
   * else's building — never the full record.
   */
  findByPostalCode(postalCode: string) {
    return this.prisma.building.findUnique({
      where: { postalCode },
      select: { id: true, name: true, city: true },
    });
  }

  listUnits(buildingId: string) {
    return this.prisma.unit.findMany({ where: { buildingId }, orderBy: { unitNumber: 'asc' } });
  }

  findUnitById(unitId: string) {
    return this.prisma.unit.findUnique({ where: { id: unitId } });
  }

  /** 21_ADRs > ADR-058 — Governance's BLOCK-scoped votes need to verify a `scopeBlockId` belongs to the same building before publishing against it. */
  findBlockById(blockId: string) {
    return this.prisma.block.findUnique({ where: { id: blockId } });
  }

  /** 21_ADRs > ADR-058 — Governance's SELECTED_UNITS-scoped votes need to verify every `scopeUnitIds` entry belongs to the same building. */
  countUnitsByIdsInBuilding(buildingId: string, unitIds: string[]): Promise<number> {
    return this.prisma.unit.count({ where: { buildingId, id: { in: unitIds } } });
  }

  /**
   * Owner-invite auto-linking (06_User_Flows > Building Setup Assistant:
   * "reconciliation is a fast-follow" — this is that fast-follow). Finds
   * every skeleton unit whose free-text `ownerPhone` (captured pre-signup
   * via `inviteOwner`) matches a phone number, and that doesn't already
   * have a *current* Ownership row — so a unit only auto-links once; a
   * later manual ownership transfer is never silently overwritten by a
   * stale invite.
   */
  findUnlinkedOwnerUnitsByPhone(phone: string) {
    return this.prisma.unit.findMany({
      where: {
        ownerPhone: phone,
        ownerships: { none: { isCurrent: true } },
      },
      select: { id: true, buildingId: true, ownerFullName: true },
    });
  }

  /**
   * Atomically creates the Ownership row (Property First — 04_Product_
   * Architecture) and the corresponding OWNER Membership for a person who
   * just signed up (or logged in) with a phone number that matches a
   * pending owner invite.
   */
  linkOwnerToUnit(params: { unitId: string; buildingId: string; personId: string }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.ownership.create({
        data: { unitId: params.unitId, personId: params.personId },
      });
      return tx.membership.create({
        data: {
          personId: params.personId,
          buildingId: params.buildingId,
          unitId: params.unitId,
          role: 'OWNER',
        },
      });
    });
  }

  /**
   * Creates the Building, the founding Membership, and the auto-generated
   * skeleton units ("واحد 1".."واحد N") all atomically — a building never
   * exists without at least one Owner or Manager attached
   * (05_Business_Rules > Building Rules / Membership Rules), and per the
   * new wizard the units always exist from the moment the building does
   * (06_User_Flows > Building Setup Assistant: "Create Skeleton Units").
   */
  createBuildingWithFoundingMember(params: {
    createdById: string;
    role: 'OWNER' | 'MANAGER';
    name?: string;
    buildingType: BuildingType;
    description?: string;
    country: string;
    province?: string;
    city: string;
    district: string;
    mainStreet: string;
    subStreet?: string;
    alley?: string;
    plateNumber: string;
    addressLine: string;
    postalCode: string;
    totalBlocks: number;
    totalUnits: number;
    totalFloors?: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const building = await tx.building.create({
        data: {
          name: params.name && params.name.trim().length > 0 ? params.name : `ساختمان ${params.mainStreet}`,
          buildingType: params.buildingType,
          description: params.description,
          country: params.country,
          province: params.province,
          city: params.city,
          district: params.district,
          mainStreet: params.mainStreet,
          subStreet: params.subStreet,
          alley: params.alley,
          plateNumber: params.plateNumber,
          addressLine: params.addressLine,
          postalCode: params.postalCode,
          totalBlocks: params.totalBlocks,
          totalUnits: params.totalUnits,
          totalFloors: params.totalFloors,
          createdById: params.createdById,
        },
      });

      await tx.membership.create({
        data: {
          personId: params.createdById,
          buildingId: building.id,
          role: params.role as MembershipRole,
          managerState: params.role === 'MANAGER' ? 'PROVISIONAL' : null,
          managerAssignmentType: params.role === 'MANAGER' ? 'PROVISIONAL' : null,
        },
      });

      if (params.totalUnits > 0) {
        await tx.unit.createMany({
          data: Array.from({ length: params.totalUnits }, (_, i) => ({
            buildingId: building.id,
            unitNumber: String(i + 1),
          })),
        });
      }

      return building;
    });
  }

  createUnit(params: {
    buildingId: string;
    blockId?: string;
    floorId?: string;
    unitNumber: string;
    type?: UnitType;
    areaSqm?: number;
  }) {
    return this.prisma.unit.create({ data: params });
  }

  updateUnit(
    unitId: string,
    params: {
      floorNumber?: number;
      areaSqm?: number;
      parkingCount?: number;
      storageCount?: number;
      occupancyStatus?: UnitOccupancyStatus;
      ownerFullName?: string;
      ownerPhone?: string;
    },
  ) {
    return this.prisma.unit.update({ where: { id: unitId }, data: params });
  }

  markOwnerInviteSent(unitId: string) {
    return this.prisma.unit.update({
      where: { id: unitId },
      data: { ownerInviteSentAt: new Date() },
    });
  }

  createMembershipRequest(params: {
    buildingId: string;
    personId: string;
    role: MembershipRole;
    message?: string;
  }) {
    return this.prisma.membershipRequest.create({ data: params });
  }

  listMembershipRequests(buildingId: string) {
    return this.prisma.membershipRequest.findMany({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findMembershipRequestById(id: string) {
    return this.prisma.membershipRequest.findUnique({ where: { id } });
  }

  updateMembershipRequestStatus(id: string, status: MembershipRequestStatus) {
    return this.prisma.membershipRequest.update({ where: { id }, data: { status } });
  }

  createMembership(params: { personId: string; buildingId: string; role: MembershipRole }) {
    return this.prisma.membership.create({
      data: {
        personId: params.personId,
        buildingId: params.buildingId,
        role: params.role,
        managerState: params.role === 'MANAGER' ? 'PROVISIONAL' : null,
        managerAssignmentType: params.role === 'MANAGER' ? 'APPOINTED' : null,
      },
    });
  }

  // --- Authorization Layer (21_ADRs > ADR-022) ----------------------------

  /** Used by RolesGuard — every current role this person holds on this building. */
  async getRoles(personId: string, buildingId: string): Promise<MembershipRole[]> {
    const rows = await this.prisma.membership.findMany({
      where: { personId, buildingId, isCurrent: true },
      select: { role: true },
    });
    return rows.map((r) => r.role);
  }

  /**
   * Used by `VerifiedRolesGuard` (21_ADRs > ADR-038) — the same current
   * roles `getRoles` returns, except a `MANAGER` row only counts while its
   * `managerState` is `VERIFIED`. A PROVISIONAL (not yet reviewed) or
   * SUSPENDED (07.02 Rule 010 / 06.03 Rule 006 — "blocks governance
   * features until reverified") manager holds the Membership row but does
   * not pass a route guarded this way. Every other role (BOARD_MEMBER,
   * OWNER, TENANT, ACCOUNTANT) has no `managerState` concept and always
   * counts, same as `getRoles`.
   */
  async getVerifiedRoles(personId: string, buildingId: string): Promise<MembershipRole[]> {
    const rows = await this.prisma.membership.findMany({
      where: { personId, buildingId, isCurrent: true },
      select: { role: true, managerState: true },
    });
    return rows.filter((r) => r.role !== 'MANAGER' || r.managerState === 'VERIFIED').map((r) => r.role);
  }

  // --- Notification recipient resolution (21_ADRs > ADR-027) --------------
  // These exist purely so NotificationsModule can resolve "who should hear
  // about this event" without importing Finance/Governance/Cases — the
  // same "notifications only depend on BuildingModule" decoupling ADR-026
  // used for Documents.

  /** Every current member of a building, any role — used for building-wide broadcasts (e.g. a new Charge Batch or Vote). */
  async listCurrentMemberPersonIds(buildingId: string): Promise<string[]> {
    const rows = await this.prisma.membership.findMany({
      where: { buildingId, isCurrent: true },
      select: { personId: true },
      distinct: ['personId'],
    });
    return rows.map((r) => r.personId);
  }

  /** Current members holding any of the given roles — used for privileged-role broadcasts (e.g. a new Case needs triage). */
  async listCurrentMemberPersonIdsByRoles(buildingId: string, roles: MembershipRole[]): Promise<string[]> {
    const rows = await this.prisma.membership.findMany({
      where: { buildingId, isCurrent: true, role: { in: roles } },
      select: { personId: true },
      distinct: ['personId'],
    });
    return rows.map((r) => r.personId);
  }

  /** Current owner(s) of a specific unit — used to reach the resident a Payment event actually concerns. */
  async getCurrentOwnerPersonIds(unitId: string): Promise<string[]> {
    const rows = await this.prisma.ownership.findMany({
      where: { unitId, isCurrent: true },
      select: { personId: true },
    });
    return rows.map((r) => r.personId);
  }

  // --- Manager Assignment (21_ADRs > ADR-022) -----------------------------

  /**
   * The active MANAGER-role Membership for a building, if any. There is
   * at most one at a time (enforced transactionally by `changeManager`
   * below, never by a DB constraint alone, since "current" is scoped by
   * `isCurrent` not by a unique index).
   */
  getCurrentManagerMembership(buildingId: string) {
    return this.prisma.membership.findFirst({
      where: { buildingId, role: 'MANAGER', isCurrent: true },
      include: { person: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  /**
   * Every MANAGER-role Membership row ever created for this building,
   * current and past — this list itself IS the manager assignment
   * history (no separate `building_managements` table; see schema.prisma
   * comment on `Membership.managerAssignmentType`).
   */
  listManagementHistory(buildingId: string) {
    return this.prisma.membership.findMany({
      where: { buildingId, role: 'MANAGER' },
      orderBy: { startedAt: 'desc' },
      include: {
        person: { select: { id: true, fullName: true, phone: true } },
        assignedBy: { select: { id: true, fullName: true, phone: true } },
      },
    });
  }

  /**
   * Atomically ends the current manager (if any) and starts a new one.
   * This transaction IS the succession event — the ended row's
   * `managerState -> FORMER` plus the new row together form the history
   * entry, so nothing else needs to be written.
   */
  changeManager(params: {
    buildingId: string;
    newManagerPersonId: string;
    assignmentType: ManagerAssignmentType;
    // Optional: a scheduler-driven ELECTED handoff (21_ADRs > ADR-036) has
    // no staff actor. `Membership.assignedById` is already nullable.
    assignedById: string | undefined;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { buildingId: params.buildingId, role: 'MANAGER', isCurrent: true },
      });

      if (current) {
        await tx.membership.update({
          where: { id: current.id },
          data: { isCurrent: false, endedAt: new Date(), managerState: 'FORMER' },
        });
      }

      // BACKOFFICE_ASSIGNED/ELECTED/APPOINTED are all the result of some
      // confirming process that already happened (platform decision,
      // election result, or a verified manager's own appointment) — only
      // PROVISIONAL (a bare self-claim) still needs the extra verify step,
      // which as of ADR-029 goes through a real `ManagerVerificationCase`
      // in `BackOfficeModule`, not a same-request auto-confirmation.
      const managerState = params.assignmentType === 'PROVISIONAL' ? 'PROVISIONAL' : 'VERIFIED';

      const created = await tx.membership.create({
        data: {
          personId: params.newManagerPersonId,
          buildingId: params.buildingId,
          role: 'MANAGER',
          managerState,
          managerAssignmentType: params.assignmentType,
          assignedById: params.assignedById,
        },
      });

      // A successful, verified manager handoff always ends Recovery Mode
      // (06.03_Manager_Verification_Flow Rule 010/011 — ADR-029), whatever
      // the reason the building entered it. A PROVISIONAL assignment does
      // NOT clear it yet — recovery only truly ends once that provisional
      // claim is itself verified (see `ManagerVerificationService`).
      if (managerState === 'VERIFIED') {
        await tx.building.update({ where: { id: params.buildingId }, data: { recoveryModeEnteredAt: null } });
      }

      return created;
    });
  }

  verifyManagerMembership(membershipId: string) {
    return this.prisma.membership.update({
      where: { id: membershipId },
      data: { managerState: 'VERIFIED' },
    });
  }

  endManagement(membershipId: string) {
    return this.prisma.membership.update({
      where: { id: membershipId },
      data: { isCurrent: false, endedAt: new Date(), managerState: 'FORMER' },
    });
  }

  /**
   * 07.02 Rule 008/010 — a SUSPEND decision on a `ManagerVerificationCase`
   * is distinct from a REJECT: the membership stays `isCurrent` (the person
   * is still nominally the manager of record) but `managerState` moves to
   * `SUSPENDED`, which is enough to block the governance-features-require
   * -verified-manager gate (06.03 Rule 006) without erasing the assignment
   * the way `endManagement`'s `FORMER` does. Building enters Recovery Mode
   * the same as a rejection (06.03 Rule 010) — see `ManagerVerificationService`.
   */
  suspendManagement(membershipId: string) {
    return this.prisma.membership.update({
      where: { id: membershipId },
      data: { managerState: 'SUSPENDED' },
    });
  }

  // --- BackOffice support (21_ADRs > ADR-029) ------------------------------
  // Small, narrowly-scoped additions reused by `BackOfficeModule` — the
  // same "extend BuildingRepository, don't add a cross-module import"
  // convention every prior ADR (Notifications' recipient helpers,
  // Gamification's own three helpers) has followed.

  /**
   * Building Verification's only real, computable-today risk signal
   * (21_ADRs > ADR-029 Decision point 2): other buildings sharing the same
   * city/district/main street but a DIFFERENT postal code and a different
   * creator. True postal-code duplicates are already impossible — `Building
   * .postalCode` has been `@unique` since ADR-021 — this catches the
   * weaker "same street, different code" near-duplicate pattern instead.
   */
  async findSimilarAddressBuildings(params: {
    city: string;
    district: string;
    mainStreet: string;
    excludeBuildingId: string;
    excludeCreatedById: string;
  }) {
    return this.prisma.building.findMany({
      where: {
        city: params.city,
        district: params.district,
        mainStreet: params.mainStreet,
        id: { not: params.excludeBuildingId },
        createdById: { not: params.excludeCreatedById },
      },
      select: { id: true, name: true, createdById: true },
      take: 5,
    });
  }

  /** Distinct current OWNER-role members of a building — the denominator for the 30% Owner Approval threshold (06.03 Rule 002). */
  async countCurrentOwners(buildingId: string): Promise<number> {
    const rows = await this.prisma.membership.findMany({
      where: { buildingId, role: 'OWNER', isCurrent: true },
      select: { personId: true },
      distinct: ['personId'],
    });
    return rows.length;
  }

  updateBuildingStatus(buildingId: string, status: BuildingStatus) {
    return this.prisma.building.update({ where: { id: buildingId }, data: { status } });
  }

  /** Recovery Mode (06.03 Rule 010/011) — a building has no active, verified manager. Cleared automatically once a VERIFIED manager takes over (see `changeManager` above). No scheduler auto-expires it (same gap as every other domain's deferred scheduler-driven transition) — it stays set until a human or the verification flow resolves it. */
  setRecoveryMode(buildingId: string, entering: boolean) {
    return this.prisma.building.update({
      where: { id: buildingId },
      data: { recoveryModeEnteredAt: entering ? new Date() : null },
    });
  }

  // --- Ownership Transfer (10.07.02 — see 21_ADRs > ADR-035) ---------------

  /** Used by `OwnershipTransferPolicy.assertCallerIsCurrentOwner` — is this specific person the unit's current owner right now? (Not a building-wide `RolesGuard` check — that can't distinguish "an owner of this building" from "the owner of THIS unit".) */
  async isCurrentOwnerOfUnit(unitId: string, personId: string): Promise<boolean> {
    const count = await this.prisma.ownership.count({ where: { unitId, personId, isCurrent: true } });
    return count > 0;
  }

  listOwnershipHistoryForUnit(unitId: string) {
    return this.prisma.ownership.findMany({
      where: { unitId },
      orderBy: { startDate: 'desc' },
      include: { person: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  /**
   * Ends every current `Ownership` row (and the paired OWNER `Membership`
   * row) for the unit, then repoints `Unit.ownerPhone` at the incoming
   * owner — the exact same field `findUnlinkedOwnerUnitsByPhone` already
   * scans, so the transfer completes automatically via the already-shipped
   * `linkOwnerToUnit` auto-link path the next time that phone number
   * verifies OTP (see this model's own schema comment). Uses `updateMany`
   * rather than assuming exactly one current owner — the shipped schema
   * has never enforced single-ownership-per-unit at the DB level (Voting's
   * own eligibility snapshot already has to filter out co-owned units, see
   * ADR-024), so a transfer clears every current owner, not just one.
   */
  transferOwnership(params: { unitId: string; newOwnerPhone: string }) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.ownership.updateMany({
        where: { unitId: params.unitId, isCurrent: true },
        data: { isCurrent: false, endDate: now },
      });
      await tx.membership.updateMany({
        where: { unitId: params.unitId, role: 'OWNER', isCurrent: true },
        data: { isCurrent: false, endedAt: now },
      });
      return tx.unit.update({
        where: { id: params.unitId },
        data: { ownerPhone: params.newOwnerPhone, ownerFullName: null, ownerInviteSentAt: null },
      });
    });
  }

  // --- Tenancy (10.07.03 — see 21_ADRs > ADR-035) ---------------------------

  findCurrentTenancyForUnit(unitId: string) {
    return this.prisma.tenancy.findFirst({ where: { unitId, isCurrent: true } });
  }

  findTenancyById(id: string) {
    return this.prisma.tenancy.findUnique({ where: { id } });
  }

  listTenanciesForUnit(unitId: string) {
    return this.prisma.tenancy.findMany({
      where: { unitId },
      orderBy: { startDate: 'desc' },
      include: { person: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  /**
   * Same sync pattern `linkOwnerToUnit` already established for Ownership
   * (19_Current_Sprint's own "Planned Next" note): the `Tenancy` row and
   * the TENANT `Membership` row are created together, atomically, and
   * `Unit.occupancyStatus` — shipped since ADR-021 but never actually
   * maintained by any code until now — starts being kept in sync too.
   */
  createTenancy(params: { unitId: string; buildingId: string; personId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const tenancy = await tx.tenancy.create({
        data: { unitId: params.unitId, personId: params.personId },
      });
      await tx.membership.create({
        data: {
          personId: params.personId,
          buildingId: params.buildingId,
          unitId: params.unitId,
          role: 'TENANT',
        },
      });
      await tx.unit.update({
        where: { id: params.unitId },
        data: { occupancyStatus: 'TENANT_OCCUPIED' },
      });
      return tenancy;
    });
  }

  giveTenancyNotice(id: string) {
    return this.prisma.tenancy.update({
      where: { id },
      data: { status: 'NOTICE_GIVEN', noticeGivenAt: new Date() },
    });
  }

  /**
   * Ends the `Tenancy` row and the paired TENANT `Membership` row
   * together, and resets `Unit.occupancyStatus` to VACANT — a disclosed
   * simplification, since no code anywhere tracks OWNER_OCCUPIED (an owner
   * living in their own unit is never recorded as such today), so this
   * cannot distinguish "genuinely vacant" from "the owner lives here" on
   * tenancy end. See 21_ADRs > ADR-035 Decision/Future Review.
   */
  endTenancy(params: { id: string; unitId: string; personId: string; terminationReason?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const tenancy = await tx.tenancy.update({
        where: { id: params.id },
        data: { isCurrent: false, status: 'ENDED', endDate: now, terminationReason: params.terminationReason },
      });
      await tx.membership.updateMany({
        where: { unitId: params.unitId, personId: params.personId, role: 'TENANT', isCurrent: true },
        data: { isCurrent: false, endedAt: now },
      });
      await tx.unit.update({
        where: { id: params.unitId },
        data: { occupancyStatus: 'VACANT' },
      });
      return tenancy;
    });
  }
}
