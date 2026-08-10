import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  BuildingStatus,
  BuildingVerificationDecision,
  CaseStatus,
  ComplianceCaseCategory,
  EnforcementActionType,
  EnforcementAppealStatus,
  EnforcementTargetType,
  FeatureGrantType,
  FraudCaseSource,
  FraudCaseStatus,
  FraudSignalType,
  ManagerVerificationDecision,
  ManagerVerificationSource,
  ManagerVerificationStatus,
  PlatformStaffRole,
  PaymentStatus,
  SubscriptionFeatureKey,
  SubscriptionPlan,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCaseResolutionCode,
  VerificationPriority,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  ConflictError,
  DuplicateError,
  NotFoundAppError,
  ValidationError,
} from '../../../../common/errors/app-error';

const PLATFORM_STAFF_RANK: Record<PlatformStaffRole, number> = {
  REVIEWER: 1,
  SENIOR_REVIEWER: 2,
  PLATFORM_ADMIN: 3,
};

@Injectable()
export class BackOfficeRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Platform staff -------------------------------------------------------

  getActivePlatformStaff(personId: string) {
    return this.prisma.platformStaff.findFirst({ where: { personId, isActive: true } });
  }

  // --- Building Verification (07.01) ----------------------------------------

  createBuildingVerificationCase(params: {
    buildingId: string;
    status: BuildingStatus;
    priority: VerificationPriority;
    riskScore: number;
    riskFlags: string[];
    isAppeal?: boolean;
    previousCaseId?: string;
    decision?: BuildingVerificationDecision;
    reason?: string;
    decidedAt?: Date;
  }) {
    return this.prisma.buildingVerificationCase.create({
      data: {
        buildingId: params.buildingId,
        status: params.status,
        priority: params.priority,
        riskScore: params.riskScore,
        riskFlags: params.riskFlags,
        isAppeal: params.isAppeal ?? false,
        previousCaseId: params.previousCaseId,
        decision: params.decision,
        reason: params.reason,
        decidedAt: params.decidedAt,
      },
    });
  }

  findBuildingVerificationCaseById(id: string) {
    return this.prisma.buildingVerificationCase.findUnique({
      where: { id },
      include: {
        building: { select: { id: true, name: true, addressLine: true, createdById: true } },
      },
    });
  }

  /** Most recent case for a building — used to find the case an appeal should link back to, and to enforce "at most one open case at a time." */
  getLatestBuildingVerificationCase(buildingId: string) {
    return this.prisma.buildingVerificationCase.findFirst({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); this is a platform-wide, unbounded queue (`27_Performance_Review_v1.0` §1.3). */
  async listBuildingVerificationCases(
    filters: {
      status?: BuildingStatus;
      priority?: VerificationPriority;
      assignedToId?: string;
    },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: filters.status,
      priority: filters.priority,
      assignedToId: filters.assignedToId,
    };
    const [items, total] = await Promise.all([
      this.prisma.buildingVerificationCase.findMany({
        where,
        include: { building: { select: { id: true, name: true, addressLine: true, city: true } } },
        // 07.01 Rule 012: Queue Ordered By Priority Then Age.
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.buildingVerificationCase.count({ where }),
    ]);
    return { items, total };
  }

  async assignBuildingVerificationCase(id: string, assignedToId: string) {
    const updated = await this.prisma.buildingVerificationCase.updateMany({
      where: { id, status: { in: ['PENDING', 'UNDER_REVIEW', 'PENDING_INFORMATION'] } },
      data: { assignedToId },
    });
    if (updated.count !== 1) {
      throw new ConflictError('Building verification case status changed; reload and retry.');
    }
    return this.prisma.buildingVerificationCase.findUniqueOrThrow({ where: { id } });
  }

  listBuildingVerificationAssigneeCandidateIds() {
    return this.prisma.platformStaff.findMany({
      select: { personId: true },
      orderBy: { personId: 'asc' },
    });
  }

  findBuildingVerificationAssigneeCandidate(personId: string) {
    return this.prisma.platformStaff.findUnique({
      where: { personId },
      select: {
        personId: true,
        role: true,
        isActive: true,
        person: { select: { fullName: true, isSuspended: true } },
      },
    });
  }

  decideBuildingVerificationCase(params: {
    id: string;
    status: BuildingStatus;
    decision: BuildingVerificationDecision;
    reviewedById?: string;
    reason?: string;
  }) {
    return this.prisma.buildingVerificationCase.update({
      where: { id: params.id },
      data: {
        status: params.status,
        decision: params.decision,
        reviewedById: params.reviewedById,
        reason: params.reason,
        decidedAt: new Date(),
      },
    });
  }

  // --- Manager Verification (07.02 / 06.03) ----------------------------------

  createManagerVerificationCase(params: {
    buildingId: string;
    membershipId: string;
    candidateId: string;
    priority: VerificationPriority;
    isReverification?: boolean;
  }) {
    return this.prisma.managerVerificationCase.create({
      data: {
        buildingId: params.buildingId,
        membershipId: params.membershipId,
        candidateId: params.candidateId,
        priority: params.priority,
        isReverification: params.isReverification ?? false,
      },
    });
  }

  findManagerVerificationCaseById(id: string) {
    return this.prisma.managerVerificationCase.findUnique({
      where: { id },
      include: {
        building: { select: { id: true, name: true } },
        candidate: { select: { id: true, fullName: true, phone: true } },
        approvals: true,
      },
    });
  }

  /** The single open (PENDING) case for a building, if any — 06.03 Rule 009 ("Only One Verified Manager At A Time") implies at most one open verification case too. */
  getOpenManagerVerificationCaseForBuilding(buildingId: string) {
    return this.prisma.managerVerificationCase.findFirst({
      where: { buildingId, status: 'PENDING' },
    });
  }

  findLatestManagerVerificationCaseForBuilding(buildingId: string) {
    return this.prisma.managerVerificationCase.findFirst({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Unpaginated — kept as-is for `ManagerVerificationService.appealCase`'s internal full-scan lookup. The controller-facing staff queue uses `listManagerVerificationCasesPaged` below instead (21_ADRs > ADR-072). */
  listManagerVerificationCases(filters: {
    status?: ManagerVerificationStatus;
    priority?: VerificationPriority;
  }) {
    return this.prisma.managerVerificationCase.findMany({
      where: { status: filters.status, priority: filters.priority },
      include: {
        building: { select: { id: true, name: true } },
        candidate: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /** 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); this is a platform-wide, unbounded queue (`27_Performance_Review_v1.0` §1.3). */
  async listManagerVerificationCasesPaged(
    filters: { status?: ManagerVerificationStatus; priority?: VerificationPriority },
    pagination: { skip: number; take: number },
  ) {
    const where = { status: filters.status, priority: filters.priority };
    const [items, total] = await Promise.all([
      this.prisma.managerVerificationCase.findMany({
        where,
        include: {
          building: { select: { id: true, name: true } },
          candidate: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.managerVerificationCase.count({ where }),
    ]);
    return { items, total };
  }

  decideManagerVerificationCase(params: {
    id: string;
    status: ManagerVerificationStatus;
    decision?: ManagerVerificationDecision;
    verificationSource?: ManagerVerificationSource;
    reviewedById?: string;
    reason?: string;
  }) {
    return this.prisma.managerVerificationCase.update({
      where: { id: params.id },
      data: {
        status: params.status,
        decision: params.decision,
        verificationSource: params.verificationSource,
        reviewedById: params.reviewedById,
        reason: params.reason,
        decidedAt: new Date(),
      },
    });
  }

  async decideManagerVerificationCaseAtomically(params: {
    id: string;
    buildingId: string;
    membershipId: string;
    candidateId: string;
    status: ManagerVerificationStatus;
    decision: ManagerVerificationDecision;
    verificationSource?: ManagerVerificationSource;
    reviewedById: string;
    reason?: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'manager-verification-case:' + params.id}))`,
      );
      const changed = await tx.managerVerificationCase.updateMany({
        where: { id: params.id, status: 'PENDING' },
        data: {
          status: params.status,
          decision: params.decision,
          verificationSource: params.verificationSource,
          reviewedById: params.reviewedById,
          reason: params.reason,
          decidedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ConflictError('Manager verification case status changed; reload and retry.');
      }

      if (params.decision !== 'REJECT') {
        const competingManager = await tx.membership.findFirst({
          where: {
            buildingId: params.buildingId,
            role: 'MANAGER',
            isCurrent: true,
            id: { not: params.membershipId },
          },
          select: { id: true },
        });
        if (competingManager) {
          throw new ConflictError('Another current manager exists for this building.');
        }
      }
      const membershipData =
        params.decision === 'APPROVE'
          ? { managerState: 'VERIFIED' as const, isCurrent: true, endedAt: null }
          : params.decision === 'REJECT'
            ? { managerState: 'FORMER' as const, isCurrent: false, endedAt: new Date() }
            : { managerState: 'SUSPENDED' as const, isCurrent: true, endedAt: null };
      const membership = await tx.membership.updateMany({
        where: {
          id: params.membershipId,
          buildingId: params.buildingId,
          personId: params.candidateId,
        },
        data: membershipData,
      });
      if (membership.count !== 1) {
        throw new ConflictError('Manager membership changed; reload and retry.');
      }
      const building = await tx.building.updateMany({
        where: { id: params.buildingId },
        data: { recoveryModeEnteredAt: params.decision === 'APPROVE' ? null : new Date() },
      });
      if (building.count !== 1) throw new ConflictError('Building changed; reload and retry.');

      await tx.auditLog.create({
        data: {
          actorId: params.reviewedById,
          buildingId: params.buildingId,
          action: 'ManagerVerificationDecided',
          entityType: 'ManagerVerificationCase',
          entityId: params.id,
          requestId: params.requestId,
          reason: params.reason,
          metadata: { decision: params.decision },
        },
      });
      return tx.managerVerificationCase.findUniqueOrThrow({ where: { id: params.id } });
    });
  }

  async restoreManagerVerificationCaseAtomically(params: {
    suspendedCaseId: string;
    reviewerPersonId: string;
    reason?: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'manager-verification-restore:' + params.suspendedCaseId}))`,
      );
      const suspended = await tx.managerVerificationCase.findUnique({
        where: { id: params.suspendedCaseId },
      });
      if (!suspended)
        throw new ConflictError('Manager verification case changed; reload and retry.');
      if (suspended.status !== 'SUSPENDED') {
        throw new ConflictError('Manager verification case is no longer restorable.');
      }
      const existing = await tx.managerVerificationCase.findFirst({
        where: {
          buildingId: suspended.buildingId,
          membershipId: suspended.membershipId,
          candidateId: suspended.candidateId,
          isReverification: true,
          decision: 'RESTORE',
        },
      });
      if (existing) throw new ConflictError('Manager verification case was already restored.');

      const restored = await tx.managerVerificationCase.create({
        data: {
          buildingId: suspended.buildingId,
          membershipId: suspended.membershipId,
          candidateId: suspended.candidateId,
          priority: 'NORMAL',
          isReverification: true,
          status: 'VERIFIED',
          decision: 'RESTORE',
          verificationSource: 'ADMIN_REVIEW',
          reviewedById: params.reviewerPersonId,
          reason: params.reason,
          decidedAt: new Date(),
        },
      });
      const competingManager = await tx.membership.findFirst({
        where: {
          buildingId: suspended.buildingId,
          role: 'MANAGER',
          isCurrent: true,
          id: { not: suspended.membershipId },
        },
        select: { id: true },
      });
      if (competingManager) {
        throw new ConflictError('Another current manager exists for this building.');
      }
      const membership = await tx.membership.updateMany({
        where: {
          id: suspended.membershipId,
          buildingId: suspended.buildingId,
          personId: suspended.candidateId,
          managerState: 'SUSPENDED',
        },
        data: { managerState: 'VERIFIED', isCurrent: true, endedAt: null },
      });
      if (membership.count !== 1) {
        throw new ConflictError('Suspended manager membership changed; reload and retry.');
      }
      const building = await tx.building.updateMany({
        where: { id: suspended.buildingId },
        data: { recoveryModeEnteredAt: null },
      });
      if (building.count !== 1) throw new ConflictError('Building changed; reload and retry.');
      await tx.auditLog.create({
        data: {
          actorId: params.reviewerPersonId,
          buildingId: suspended.buildingId,
          action: 'ManagerVerificationRestored',
          entityType: 'ManagerVerificationCase',
          entityId: restored.id,
          requestId: params.requestId,
          reason: params.reason,
          metadata: { suspendedCaseId: suspended.id },
        },
      });
      return restored;
    });
  }

  async castManagerVerificationApprovalAtomically(params: {
    caseId: string;
    ownerPersonId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'manager-verification-case:' + params.caseId}))`,
      );
      const kase = await tx.managerVerificationCase.findUnique({ where: { id: params.caseId } });
      if (!kase || kase.status !== 'PENDING') {
        throw new ConflictError('Manager verification case status changed; reload and retry.');
      }
      const duplicate = await tx.managerVerificationApproval.findUnique({
        where: {
          caseId_ownerPersonId: { caseId: params.caseId, ownerPersonId: params.ownerPersonId },
        },
      });
      if (duplicate) throw new DuplicateError('Owner approval was already recorded.');
      try {
        await tx.managerVerificationApproval.create({
          data: { caseId: params.caseId, ownerPersonId: params.ownerPersonId },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new DuplicateError('Owner approval was already recorded.');
        }
        throw error;
      }
      const [approverCount, owners] = await Promise.all([
        tx.managerVerificationApproval.count({ where: { caseId: params.caseId } }),
        tx.membership.findMany({
          where: { buildingId: kase.buildingId, role: 'OWNER', isCurrent: true },
          select: { personId: true },
          distinct: ['personId'],
        }),
      ]);
      const totalOwners = owners.length;
      await tx.auditLog.create({
        data: {
          actorId: params.ownerPersonId,
          buildingId: kase.buildingId,
          action: 'ManagerVerificationApprovalCast',
          entityType: 'ManagerVerificationCase',
          entityId: kase.id,
          requestId: params.requestId,
          metadata: { approverCount, totalOwners },
        },
      });
      const resolved =
        totalOwners > 0 && approverCount * 100 >= totalOwners * kase.requiredApprovalPercent;
      if (!resolved) return { case: kase, resolved, approverCount, totalOwners };

      const changed = await tx.managerVerificationCase.updateMany({
        where: { id: kase.id, status: 'PENDING' },
        data: {
          status: 'VERIFIED',
          decision: 'APPROVE',
          verificationSource: 'OWNER_APPROVAL',
          reason: `Approved by ${approverCount}/${totalOwners} current owners (>= ${kase.requiredApprovalPercent}% required).`,
          decidedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ConflictError('Manager verification case status changed; reload and retry.');
      }
      const competingManager = await tx.membership.findFirst({
        where: {
          buildingId: kase.buildingId,
          role: 'MANAGER',
          isCurrent: true,
          id: { not: kase.membershipId },
        },
        select: { id: true },
      });
      if (competingManager) {
        throw new ConflictError('Another current manager exists for this building.');
      }
      const membership = await tx.membership.updateMany({
        where: {
          id: kase.membershipId,
          buildingId: kase.buildingId,
          personId: kase.candidateId,
        },
        data: { managerState: 'VERIFIED', isCurrent: true, endedAt: null },
      });
      if (membership.count !== 1) throw new ConflictError('Manager membership changed.');
      const building = await tx.building.updateMany({
        where: { id: kase.buildingId },
        data: { recoveryModeEnteredAt: null },
      });
      if (building.count !== 1) throw new ConflictError('Building changed; reload and retry.');
      await tx.auditLog.create({
        data: {
          buildingId: kase.buildingId,
          action: 'ManagerVerificationDecided',
          entityType: 'ManagerVerificationCase',
          entityId: kase.id,
          requestId: params.requestId,
          metadata: { verificationSource: 'OWNER_APPROVAL', approverCount, totalOwners },
        },
      });
      const updated = await tx.managerVerificationCase.findUniqueOrThrow({
        where: { id: kase.id },
      });
      return { case: updated, resolved, approverCount, totalOwners };
    });
  }

  findActiveManagerVerificationReverification(buildingId: string, candidateId: string) {
    return this.prisma.managerVerificationCase.findFirst({
      where: { buildingId, candidateId, isReverification: true, status: 'PENDING' },
    });
  }

  async createManagerVerificationAppealAtomically(params: {
    sourceCaseId: string;
    callerPersonId: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'manager-verification-appeal:' + params.sourceCaseId}))`,
      );
      const source = await tx.managerVerificationCase.findUnique({
        where: { id: params.sourceCaseId },
      });
      if (!source || source.status !== 'REJECTED' || source.candidateId !== params.callerPersonId) {
        throw new ConflictError('Manager verification appeal source changed; reload and retry.');
      }
      const existing = await tx.managerVerificationCase.findFirst({
        where: {
          buildingId: source.buildingId,
          membershipId: source.membershipId,
          candidateId: source.candidateId,
          isReverification: true,
          status: 'PENDING',
        },
      });
      if (existing) throw new ConflictError('A manager verification appeal is already pending.');
      const appeal = await tx.managerVerificationCase.create({
        data: {
          buildingId: source.buildingId,
          membershipId: source.membershipId,
          candidateId: source.candidateId,
          priority: 'HIGH',
          isReverification: true,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: params.callerPersonId,
          buildingId: source.buildingId,
          action: 'ManagerVerificationAppealed',
          entityType: 'ManagerVerificationCase',
          entityId: appeal.id,
          requestId: params.requestId,
          metadata: { previousCaseId: source.id },
        },
      });
      return appeal;
    });
  }

  findManagerVerificationApproval(caseId: string, ownerPersonId: string) {
    return this.prisma.managerVerificationApproval.findUnique({
      where: { caseId_ownerPersonId: { caseId, ownerPersonId } },
    });
  }

  createManagerVerificationApproval(caseId: string, ownerPersonId: string) {
    return this.prisma.managerVerificationApproval.create({ data: { caseId, ownerPersonId } });
  }

  countManagerVerificationApprovals(caseId: string): Promise<number> {
    return this.prisma.managerVerificationApproval.count({ where: { caseId } });
  }

  // --- Fraud & Abuse Center (07.03) -------------------------------------

  createFraudCase(params: {
    source: FraudCaseSource;
    signalType?: FraudSignalType;
    priority: VerificationPriority;
    reportedById?: string;
    targetPersonId?: string;
    targetBuildingId?: string;
    description?: string;
    isReopen?: boolean;
    previousCaseId?: string;
  }) {
    return this.prisma.fraudCase.create({
      data: {
        source: params.source,
        signalType: params.signalType,
        priority: params.priority,
        reportedById: params.reportedById,
        targetPersonId: params.targetPersonId,
        targetBuildingId: params.targetBuildingId,
        description: params.description,
        isReopen: params.isReopen ?? false,
        previousCaseId: params.previousCaseId,
      },
    });
  }

  findFraudCaseById(id: string) {
    return this.prisma.fraudCase.findUnique({
      where: { id },
      include: {
        reportedBy: { select: { id: true, fullName: true, phone: true } },
        targetPerson: { select: { id: true, fullName: true, phone: true } },
        targetBuilding: { select: { id: true, name: true } },
        enforcementActions: true,
        evidence: {
          select: { id: true, notes: true, authorId: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
  }

  /** 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); this is a platform-wide, unbounded queue (`27_Performance_Review_v1.0` §1.3). */
  async listFraudCases(
    filters: {
      status?: FraudCaseStatus;
      priority?: VerificationPriority;
      assignedToId?: string;
    },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: filters.status,
      priority: filters.priority,
      assignedToId: filters.assignedToId,
    };
    const [items, total] = await Promise.all([
      this.prisma.fraudCase.findMany({
        where,
        include: {
          targetPerson: { select: { id: true, fullName: true, phone: true } },
          targetBuilding: { select: { id: true, name: true } },
        },
        // 07.03 Rule 004/009: priority-ordered queue, same convention as
        // Building/Manager Verification.
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.fraudCase.count({ where }),
    ]);
    return { items, total };
  }

  async assignFraudCase(id: string, assignedToId: string, expectedStatus: FraudCaseStatus) {
    const result = await this.prisma.fraudCase.updateMany({
      where: { id, status: expectedStatus },
      data: { assignedToId, status: 'UNDER_INVESTIGATION' },
    });
    if (result.count !== 1) throw new ConflictError('Fraud case status changed; reload and retry.');
    return this.prisma.fraudCase.findUniqueOrThrow({ where: { id } });
  }

  addFraudCaseEvidence(id: string, evidenceNotes: string, authorId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.fraudCaseEvidence.create({
        data: { fraudCaseId: id, notes: evidenceNotes, authorId },
      });
      return tx.fraudCase.update({
        where: { id },
        data: { evidenceNotes },
        include: {
          evidence: {
            select: { id: true, notes: true, authorId: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
    });
  }

  async decideFraudCase(params: {
    id: string;
    status: FraudCaseStatus;
    reviewedById: string;
    reason?: string;
    expectedStatus: FraudCaseStatus;
  }) {
    const result = await this.prisma.fraudCase.updateMany({
      where: { id: params.id, status: params.expectedStatus },
      data: {
        status: params.status,
        reviewedById: params.reviewedById,
        reason: params.reason,
        decidedAt: new Date(),
      },
    });
    if (result.count !== 1) throw new ConflictError('Fraud case status changed; reload and retry.');
    return this.prisma.fraudCase.findUniqueOrThrow({ where: { id: params.id } });
  }

  async createEnforcementActionWithEffect(params: {
    fraudCaseId: string;
    type: EnforcementActionType;
    targetType: EnforcementTargetType;
    targetPersonId?: string;
    targetBuildingId?: string;
    targetMembershipId?: string;
    reason?: string;
    issuedById: string;
    idempotencyKey: string;
  }) {
    const existing = await this.prisma.enforcementAction.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) return { action: existing, created: false };

    try {
      const action = await this.prisma.$transaction(async (tx) => {
        let previousTargetState: string | undefined;
        let effectApplied = false;
        if (params.type === 'ACCOUNT_SUSPENSION' && params.targetPersonId) {
          const target = await tx.person.findUniqueOrThrow({ where: { id: params.targetPersonId } });
          previousTargetState = JSON.stringify({ isSuspended: target.isSuspended });
          await tx.person.update({ where: { id: target.id }, data: { isSuspended: true } });
          effectApplied = true;
        } else if (
          params.type === 'VERIFICATION_REVOCATION' &&
          params.targetType === 'BUILDING' &&
          params.targetBuildingId
        ) {
          const target = await tx.building.findUniqueOrThrow({ where: { id: params.targetBuildingId } });
          previousTargetState = JSON.stringify({ status: target.status });
          await tx.building.update({ where: { id: target.id }, data: { status: 'REJECTED' } });
          effectApplied = true;
        } else if (
          params.type === 'VERIFICATION_REVOCATION' &&
          params.targetType === 'MANAGER_CLAIM' &&
          params.targetMembershipId &&
          params.targetBuildingId
        ) {
          const [membership, building] = await Promise.all([
            tx.membership.findUniqueOrThrow({ where: { id: params.targetMembershipId } }),
            tx.building.findUniqueOrThrow({ where: { id: params.targetBuildingId } }),
          ]);
          if (membership.buildingId !== building.id) {
            throw new ValidationError('The manager claim does not belong to the target building.');
          }
          previousTargetState = JSON.stringify({
            managerState: membership.managerState,
            recoveryModeEnteredAt: building.recoveryModeEnteredAt,
          });
          await tx.membership.update({
            where: { id: membership.id },
            data: { managerState: 'SUSPENDED' },
          });
          await tx.building.update({
            where: { id: building.id },
            data: { recoveryModeEnteredAt: new Date() },
          });
          effectApplied = true;
        }

        return tx.enforcementAction.create({
          data: {
            fraudCaseId: params.fraudCaseId,
            type: params.type,
            targetType: params.targetType,
            targetPersonId: params.targetPersonId,
            targetBuildingId: params.targetBuildingId,
            targetMembershipId: params.targetMembershipId,
            reason: params.reason,
            issuedById: params.issuedById,
            idempotencyKey: params.idempotencyKey,
            effectApplied,
            previousTargetState,
          },
        });
      });
      return { action, created: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const action = await this.prisma.enforcementAction.findUniqueOrThrow({
          where: { idempotencyKey: params.idempotencyKey },
        });
        return { action, created: false };
      }
      throw error;
    }
  }

  findEnforcementActionById(id: string) {
    return this.prisma.enforcementAction.findUnique({ where: { id } });
  }

  listEnforcementActionsForCase(fraudCaseId: string) {
    return this.prisma.enforcementAction.findMany({
      where: { fraudCaseId },
      orderBy: { issuedAt: 'asc' },
    });
  }

  async requestEnforcementAppeal(id: string, appealReason?: string) {
    const result = await this.prisma.enforcementAction.updateMany({
      where: { id, appealStatus: 'NONE' },
      data: { appealStatus: 'PENDING', appealReason, appealedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictError('Enforcement appeal status changed; reload and retry.');
    return this.prisma.enforcementAction.findUniqueOrThrow({ where: { id } });
  }

  async decideEnforcementAppeal(params: {
    id: string;
    appealStatus: EnforcementAppealStatus;
    appealDecidedById: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const action = await tx.enforcementAction.findUniqueOrThrow({ where: { id: params.id } });
      const changed = await tx.enforcementAction.updateMany({
        where: { id: params.id, appealStatus: 'PENDING' },
        data: {
          appealStatus: params.appealStatus,
          appealDecidedById: params.appealDecidedById,
          appealDecidedAt: new Date(),
        },
      });
      if (changed.count !== 1)
        throw new ConflictError('Enforcement appeal status changed; reload and retry.');

      if (
        params.appealStatus === 'OVERTURNED' &&
        action.effectApplied &&
        !action.effectReversedAt
      ) {
        const previous = action.previousTargetState ? JSON.parse(action.previousTargetState) : {};
        if (action.type === 'ACCOUNT_SUSPENSION' && action.targetPersonId) {
          const restored = await tx.person.updateMany({
            where: { id: action.targetPersonId, isSuspended: true },
            data: { isSuspended: previous.isSuspended },
          });
          if (restored.count !== 1) {
            throw new ConflictError('The enforcement target changed after this action.');
          }
        } else if (
          action.type === 'VERIFICATION_REVOCATION' &&
          action.targetType === 'BUILDING' &&
          action.targetBuildingId
        ) {
          const restored = await tx.building.updateMany({
            where: { id: action.targetBuildingId, status: 'REJECTED' },
            data: { status: previous.status },
          });
          if (restored.count !== 1) {
            throw new ConflictError('The enforcement target changed after this action.');
          }
        } else if (
          action.type === 'VERIFICATION_REVOCATION' &&
          action.targetType === 'MANAGER_CLAIM' &&
          action.targetMembershipId &&
          action.targetBuildingId
        ) {
          const membershipRestored = await tx.membership.updateMany({
            where: { id: action.targetMembershipId, managerState: 'SUSPENDED' },
            data: { managerState: previous.managerState },
          });
          const buildingRestored = await tx.building.updateMany({
            where: { id: action.targetBuildingId, recoveryModeEnteredAt: { not: null } },
            data: { recoveryModeEnteredAt: previous.recoveryModeEnteredAt },
          });
          if (membershipRestored.count !== 1 || buildingRestored.count !== 1) {
            throw new ConflictError('The enforcement target changed after this action.');
          }
        }
        await tx.enforcementAction.update({
          where: { id: params.id },
          data: { effectReversedAt: new Date() },
        });
      }
      return tx.enforcementAction.findUniqueOrThrow({ where: { id: params.id } });
    });
  }

  /**
   * 21_ADRs > ADR-050 — 07.03 Rule 020's "Fraud Metrics May Be Calculated"
   * (نمونه: Fraud Rate / False Report Rate / Average Investigation Time).
   * Same optional-date-range + `groupBy`/`findMany`-`reduce` shape
   * `getSupportCaseMetrics` (ADR-048) already established for the sibling
   * `07.05` metrics rule.
   */
  async getFraudCaseMetrics(fromDate?: Date, toDate?: Date) {
    const where = fromDate || toDate ? { createdAt: { gte: fromDate, lte: toDate } } : undefined;
    const [byStatusAndSource, decidedCases] = await Promise.all([
      this.prisma.fraudCase.groupBy({
        by: ['status', 'source'],
        where,
        _count: { status: true },
      }),
      this.prisma.fraudCase.findMany({
        where: { ...(where ?? {}), decidedAt: { not: null } },
        select: { createdAt: true, decidedAt: true },
      }),
    ]);

    const countFor = (status: FraudCaseStatus, source?: FraudCaseSource) =>
      byStatusAndSource
        .filter((g) => g.status === status && (source === undefined || g.source === source))
        .reduce((sum, g) => sum + g._count.status, 0);

    const confirmedCount = countFor('CONFIRMED');
    const dismissedCount = countFor('DISMISSED');
    const decidedTotal = confirmedCount + dismissedCount;

    const userReportConfirmed = countFor('CONFIRMED', 'USER_REPORT');
    const userReportDismissed = countFor('DISMISSED', 'USER_REPORT');
    const userReportDecidedTotal = userReportConfirmed + userReportDismissed;

    const investigationTimesMs = decidedCases.map(
      (c) => c.decidedAt!.getTime() - c.createdAt.getTime(),
    );
    const average = (values: number[]) =>
      values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const msToHours = (ms: number | null) => (ms === null ? null : ms / (1000 * 60 * 60));

    return {
      decidedCaseCount: decidedTotal,
      confirmedCount,
      dismissedCount,
      // Fraction of decided cases confirmed as real fraud, within the window.
      fraudRate: decidedTotal > 0 ? confirmedCount / decidedTotal : null,
      // Fraction of decided USER_REPORT cases that turned out NOT to be fraud (DISMISSED), within the window.
      falseReportRate:
        userReportDecidedTotal > 0 ? userReportDismissed / userReportDecidedTotal : null,
      avgInvestigationTimeHours: msToHours(average(investigationTimesMs)),
    };
  }

  /** 21_ADRs > ADR-031's own `ACCOUNT_SUSPENSION` effect. As of ADR-043, this flag is no longer just a record — `JwtStrategy.validate()` checks it live on every authenticated request, and `AuthService.verifyOtp`/`refresh` both refuse to issue a fresh token to a suspended Person. */
  suspendPerson(personId: string) {
    return this.prisma.person.update({ where: { id: personId }, data: { isSuspended: true } });
  }

  reinstatePerson(personId: string) {
    return this.prisma.person.update({ where: { id: personId }, data: { isSuspended: false } });
  }

  async changePersonSuspensionAtomically(params: {
    targetPersonId: string;
    actorPersonId: string;
    suspend: boolean;
    reason: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'user-admin:' + params.targetPersonId}))`;
      if (params.targetPersonId === params.actorPersonId) {
        throw new ConflictError('Staff cannot change their own suspension state.');
      }
      const [actor, target] = await Promise.all([
        tx.platformStaff.findFirst({ where: { personId: params.actorPersonId, isActive: true } }),
        tx.person.findUnique({
          where: { id: params.targetPersonId },
          select: { id: true, isSuspended: true, platformStaff: true },
        }),
      ]);
      if (!target) throw new NotFoundAppError('Person not found.');
      if (!actor) throw new ConflictError('Active staff identity is required.');
      if (
        target.platformStaff?.isActive &&
        actor.role !== 'PLATFORM_ADMIN' &&
        PLATFORM_STAFF_RANK[actor.role] <= PLATFORM_STAFF_RANK[target.platformStaff.role]
      ) {
        throw new ConflictError('Staff cannot target equal or higher-ranked staff.');
      }
      if (
        params.suspend &&
        target.platformStaff?.isActive &&
        target.platformStaff.role === 'PLATFORM_ADMIN'
      ) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'platform-admin-usability'}))`;
        const otherUsableAdmins = await tx.platformStaff.count({
          where: {
            id: { not: target.platformStaff.id },
            role: 'PLATFORM_ADMIN',
            isActive: true,
            person: { isSuspended: false },
          },
        });
        if (otherUsableAdmins === 0) {
          throw new ConflictError('The last active usable platform admin cannot be suspended.');
        }
      }
      if (!params.suspend) {
        const activeEnforcement = await tx.enforcementAction.findFirst({
          where: {
            type: 'ACCOUNT_SUSPENSION',
            targetPersonId: params.targetPersonId,
            effectApplied: true,
            effectReversedAt: null,
          },
          select: { id: true },
        });
        if (activeEnforcement) {
          throw new ConflictError('Active account-suspension enforcement blocks reinstatement.');
        }
      }
      const expected = !params.suspend;
      const changed = await tx.person.updateMany({
        where: { id: params.targetPersonId, isSuspended: expected },
        data: { isSuspended: params.suspend },
      });
      if (changed.count !== 1) throw new ConflictError('Person suspension state changed.');
      if (params.suspend) {
        await tx.refreshToken.updateMany({
          where: { personId: params.targetPersonId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: params.actorPersonId,
          action: params.suspend ? 'PersonSuspendedByAdmin' : 'PersonReinstatedByAdmin',
          entityType: 'Person',
          entityId: params.targetPersonId,
          reason: params.reason,
          metadata: { previousValue: expected, newValue: params.suspend },
          requestId: params.requestId,
        },
      });
      return { personId: params.targetPersonId, isSuspended: params.suspend };
    });
  }

  // --- User Administration (21_ADRs > ADR-111, Stage 4) -------------------
  // Reuses `suspendPerson`/`reinstatePerson` above (previously only ever
  // called from `FraudCaseService`'s ACCOUNT_SUSPENSION enforcement
  // effect) as a direct, general-purpose staff action — `reinstatePerson`
  // in particular had no caller anywhere in this codebase until this
  // stage gave it one via `UserAdministrationService.reinstate()`.

  /** Minimal existence + current-value lookup, same shape as
   * `findPersonForBackofficeApproval` above — 404 on an unknown target,
   * previous value for the audit record's `metadata.previousValue`. */
  findPersonForSuspensionState(personId: string) {
    return this.prisma.person.findUnique({
      where: { id: personId },
      select: { id: true, isSuspended: true },
    });
  }

  /** Staff-facing list/search — `search` matches phone/email/first/last/
   * full name (case-insensitive `contains`), `isSuspended`/
   * `isBackofficeApproved` are exact-match filters. All three are
   * optional; Prisma silently ignores an `undefined` `where` key, so
   * passing every filter through unconditionally (matching
   * `listSupportCases`'s own convention above) is safe. No password/OTP
   * secret ever lived on `Person` to begin with, so the selected field
   * list here is already exhaustive-safe by construction. */
  async searchPersons(
    filters: { search?: string; isSuspended?: boolean; isBackofficeApproved?: boolean },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      isSuspended: filters.isSuspended,
      isBackofficeApproved: filters.isBackofficeApproved,
      ...(filters.search
        ? {
            OR: [
              { phone: { contains: filters.search, mode: 'insensitive' as const } },
              { email: { contains: filters.search, mode: 'insensitive' as const } },
              { firstName: { contains: filters.search, mode: 'insensitive' as const } },
              { lastName: { contains: filters.search, mode: 'insensitive' as const } },
              { fullName: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.person.findMany({
        where,
        select: {
          id: true,
          phone: true,
          email: true,
          fullName: true,
          firstName: true,
          lastName: true,
          isSuspended: true,
          isBackofficeApproved: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.person.count({ where }),
    ]);
    return { items, total };
  }

  /** Staff-facing detail view — profile fields, the two administrative
   * flags, current (`isCurrent: true`) building memberships, and the
   * `PlatformStaff` record if this Person is also platform staff.
   * Deliberately does NOT include this person's own audit history — the
   * real Audit Center search (ADR-029/ADR-034) already exists and is not
   * duplicated here, matching ADR-110's own "don't re-implement another
   * domain's job" discipline for its `recentCriticalAuditEvents` widget. */
  getPersonAdminDetail(personId: string) {
    return this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        phone: true,
        email: true,
        fullName: true,
        firstName: true,
        lastName: true,
        locale: true,
        createdAt: true,
        updatedAt: true,
        isSuspended: true,
        isBackofficeApproved: true,
        memberships: {
          where: { isCurrent: true },
          select: {
            id: true,
            buildingId: true,
            role: true,
            startedAt: true,
            building: { select: { id: true, name: true } },
          },
        },
        platformStaff: { select: { id: true, role: true, isActive: true } },
      },
    });
  }

  // --- Building Administration (21_ADRs > ADR-112, Stage 5) ---------------
  // `BUILDING_VIEW`/`BUILDING_EDIT` were reserved since ADR-098 (already
  // granted to Operations Admin, and `BUILDING_VIEW` alone additionally
  // to Finance Admin/Support Admin) but never wired to a real route —
  // same reserved-but-unused shape `USER_VIEW`/`USER_EDIT` had before
  // ADR-111. Mirrors that stage's own list/search/detail shape exactly,
  // scoped to `Building` instead of `Person`. The mutating actions
  // (`BuildingAdministrationService.lock`/`reinstate`) reuse `Building
  // Repository.updateBuildingStatus` — previously reachable only via the
  // Building Verification queue's own decide flow and `FraudCaseService`'s
  // VERIFICATION_REVOCATION enforcement effect — giving staff a direct
  // path for locking/reinstating a building's public status that never
  // originated from either of those case-based workflows.

  /** Minimal existence + current-status lookup, same shape as
   * `findPersonForSuspensionState` above — 404 on an unknown target,
   * previous value for the audit record's `metadata.previousValue`. */
  findBuildingForAdminStatusChange(buildingId: string) {
    return this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true, status: true },
    });
  }

  /** Staff-facing list/search — `search` matches name/addressLine/
   * postalCode/city (case-insensitive `contains`), `status` is an
   * exact-match filter, `hasRecoveryMode` filters on whether
   * `recoveryModeEnteredAt` is set. All optional; Prisma silently ignores
   * an `undefined` `where` key, same convention as `searchPersons`. */
  async searchBuildings(
    filters: { search?: string; status?: BuildingStatus; hasRecoveryMode?: boolean },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: filters.status,
      ...(filters.hasRecoveryMode === undefined
        ? {}
        : filters.hasRecoveryMode
          ? { recoveryModeEnteredAt: { not: null } }
          : { recoveryModeEnteredAt: null }),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' as const } },
              { addressLine: { contains: filters.search, mode: 'insensitive' as const } },
              { postalCode: { contains: filters.search, mode: 'insensitive' as const } },
              { city: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.building.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          city: true,
          district: true,
          addressLine: true,
          postalCode: true,
          totalBlocks: true,
          totalUnits: true,
          recoveryModeEnteredAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.building.count({ where }),
    ]);
    return { items, total };
  }

  /** Staff-facing detail view — profile fields, Recovery Mode, and current
   * (`isCurrent: true`) memberships. Deliberately does NOT include this
   * building's own verification/fraud case history — the real Building
   * Verification Queue and Fraud & Abuse Center already own that job,
   * matching ADR-110's/ADR-111's own "don't re-implement another domain's
   * job" discipline. */
  getBuildingAdminDetail(buildingId: string) {
    return this.prisma.building.findUnique({
      where: { id: buildingId },
      select: {
        id: true,
        name: true,
        status: true,
        buildingType: true,
        country: true,
        province: true,
        city: true,
        district: true,
        addressLine: true,
        postalCode: true,
        totalBlocks: true,
        totalUnits: true,
        totalFloors: true,
        recoveryModeEnteredAt: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
        memberships: {
          where: { isCurrent: true },
          select: {
            id: true,
            personId: true,
            role: true,
            managerState: true,
            startedAt: true,
            person: { select: { id: true, fullName: true, phone: true } },
          },
        },
      },
    });
  }

  // --- Financial Administration (21_ADRs > ADR-113, Stage 6) ---------------
  // `FINANCE_VIEW`/`FINANCE_REFUND` were reserved since ADR-098 (granted to
  // Finance Admin, plus every key to Super Admin) but never wired to a real
  // route — same reserved-but-unused shape `USER_VIEW`/`USER_EDIT` and
  // `BUILDING_VIEW`/`BUILDING_EDIT` had before ADR-111/ADR-112. Unlike
  // those two, the reversal/refund mutations themselves are NOT
  // reimplemented here — `FinanceAdministrationService` calls
  // `FinanceService.reversePayment`/`refundPayment` directly (see
  // ADR-113), because those methods' own event emission drives real payer
  // notifications and gamification effects this stage must not silently
  // drop. Only the cross-building list/search/detail reads are new,
  // staff-facing queries, added here rather than in `FinanceRepository`
  // to keep the "Backoffice-facing query lives in `BackOfficeRepository`"
  // convention `searchPersons`/`searchBuildings` already established.

  /** Cross-building staff list/search over `Payment` — `FinanceRepository
   * .listPayments`/`listPaymentsByUnit` are both single-building-scoped
   * (the in-building Finance module's own routes never needed anything
   * broader); this is the first payment query with no building filter
   * required. `search` matches the payer's phone/full name or the
   * payment's own `reference`/`note` (case-insensitive `contains`);
   * `status`/`buildingId` are exact-match filters. All optional. */
  async searchPayments(
    filters: { search?: string; status?: PaymentStatus; buildingId?: string },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: filters.status,
      buildingId: filters.buildingId,
      ...(filters.search
        ? {
            OR: [
              { reference: { contains: filters.search, mode: 'insensitive' as const } },
              { note: { contains: filters.search, mode: 'insensitive' as const } },
              {
                payer: {
                  OR: [
                    { phone: { contains: filters.search, mode: 'insensitive' as const } },
                    { fullName: { contains: filters.search, mode: 'insensitive' as const } },
                  ],
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: {
          id: true,
          buildingId: true,
          unitId: true,
          fundId: true,
          amount: true,
          method: true,
          status: true,
          reference: true,
          createdAt: true,
          payer: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items, total };
  }

  /** Staff-facing detail view — payment fields plus basic building/payer
   * context and the full refund history for this payment. Deliberately
   * does NOT include this building's own ledger/adjustment history — the
   * in-building Finance module already owns that view, matching ADR-110's/
   * ADR-111's/ADR-112's own "don't reimplement another domain's job"
   * discipline. */
  getPaymentAdminDetail(paymentId: string) {
    return this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        buildingId: true,
        building: { select: { id: true, name: true } },
        unitId: true,
        fundId: true,
        payerId: true,
        payer: { select: { id: true, fullName: true, phone: true } },
        amount: true,
        method: true,
        status: true,
        reference: true,
        note: true,
        approvedById: true,
        approvedAt: true,
        rejectedReason: true,
        reversedAt: true,
        createdAt: true,
        updatedAt: true,
        refunds: {
          select: { id: true, amount: true, reason: true, createdById: true, createdAt: true },
        },
      },
    });
  }

  // --- Marketplace Access Gate --------------------------------------------
  // Person-level platform-approval fact backing the BACKOFFICE_APPROVED
  // `AccessLevel` (see `AccessGuard`/`PersonAccessController`). Lives here,
  // not on `AuthRepository`, mirroring `suspendPerson`/`reinstatePerson`
  // above — this repository already writes Person flags directly and is
  // already exported to every module (including `MarketplaceModule`) that
  // needs to read/write it, so no new module wiring is required.

  /** Live read, same discipline as `getActivePlatformStaff` and
   * `JwtStrategy`'s own live `isSuspended` check — never trust a cached
   * or JWT-carried value for an approval fact that platform staff can
   * revoke at any time. */
  async isPersonBackofficeApproved(personId: string): Promise<boolean> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { isBackofficeApproved: true },
    });
    return person?.isBackofficeApproved ?? false;
  }

  /** Minimal existence + current-value lookup for `PersonAccessService`
   * (needs to 404 on an unknown target and needs the previous value for
   * its audit record's `metadata.previousValue`). */
  findPersonForBackofficeApproval(personId: string) {
    return this.prisma.person.findUnique({
      where: { id: personId },
      select: { id: true, isBackofficeApproved: true },
    });
  }

  /** Single grant/revoke entry point — accepts either direction so callers
   * can't accidentally end up with a grant-only workflow (Marketplace
   * Access-Gate Implementation Phase, requirement 1). Returns the updated
   * Person row so the caller (`PersonAccessService`) can read back the
   * post-update value for its audit record and response body. */
  setPersonBackofficeApproval(personId: string, approved: boolean) {
    return this.prisma.person.update({
      where: { id: personId },
      data: { isBackofficeApproved: approved },
    });
  }

  async changePersonBackofficeApprovalAtomically(params: {
    targetPersonId: string;
    actorPersonId: string;
    approved: boolean;
    reason?: string;
    requestId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'user-admin:' + params.targetPersonId}))`;
      if (params.targetPersonId === params.actorPersonId) {
        throw new ConflictError('Staff cannot change their own backoffice approval.');
      }
      const [actor, target] = await Promise.all([
        tx.platformStaff.findFirst({ where: { personId: params.actorPersonId, isActive: true } }),
        tx.person.findUnique({
          where: { id: params.targetPersonId },
          select: { id: true, isBackofficeApproved: true, platformStaff: true },
        }),
      ]);
      if (!target) throw new NotFoundAppError('Person not found.');
      if (!actor) throw new ConflictError('Active staff identity is required.');
      if (
        target.platformStaff?.isActive &&
        actor.role !== 'PLATFORM_ADMIN' &&
        PLATFORM_STAFF_RANK[actor.role] <= PLATFORM_STAFF_RANK[target.platformStaff.role]
      ) {
        throw new ConflictError('Staff cannot target equal or higher-ranked staff.');
      }
      const previousValue = !params.approved;
      const changed = await tx.person.updateMany({
        where: { id: params.targetPersonId, isBackofficeApproved: previousValue },
        data: { isBackofficeApproved: params.approved },
      });
      if (changed.count !== 1) throw new ConflictError('Person backoffice approval state changed.');
      await tx.auditLog.create({
        data: {
          actorId: params.actorPersonId,
          action: 'PersonBackofficeApprovalChanged',
          entityType: 'Person',
          entityId: params.targetPersonId,
          reason: params.reason,
          metadata: { previousValue, newValue: params.approved },
          requestId: params.requestId,
        },
      });
      return { personId: params.targetPersonId, isBackofficeApproved: params.approved };
    });
  }

  // --- Support & Operations Center (07.05) -------------------------------

  createSupportCase(params: {
    category: SupportCaseCategory;
    priority: VerificationPriority;
    subject: string;
    description: string;
    createdById: string;
    linkedEntityType?: string;
    linkedEntityId?: string;
  }) {
    return this.prisma.supportCase.create({
      data: {
        category: params.category,
        priority: params.priority,
        subject: params.subject,
        description: params.description,
        createdById: params.createdById,
        linkedEntityType: params.linkedEntityType,
        linkedEntityId: params.linkedEntityId,
      },
    });
  }

  findSupportCaseById(id: string) {
    return this.prisma.supportCase.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, fullName: true, phone: true } },
        assignedTo: { select: { id: true, fullName: true, phone: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  findSupportCaseForOwner(id: string, createdById: string) {
    return this.prisma.supportCase.findFirst({
      where: { id, createdById },
      include: {
        createdBy: { select: { id: true, fullName: true, phone: true } },
        assignedTo: { select: { id: true, fullName: true, phone: true } },
        messages: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async resolveEnforcementAppellant(action: {
    targetType: EnforcementTargetType;
    targetPersonId: string | null;
    targetBuildingId: string | null;
    targetMembershipId: string | null;
  }): Promise<string | null> {
    if (action.targetType === 'PERSON') return action.targetPersonId;
    if (action.targetType === 'MANAGER_CLAIM' && action.targetMembershipId) {
      const membership = await this.prisma.membership.findUnique({
        where: { id: action.targetMembershipId },
        select: { personId: true },
      });
      return membership?.personId ?? null;
    }
    if (action.targetType === 'BUILDING' && action.targetBuildingId) {
      const building = await this.prisma.building.findUnique({
        where: { id: action.targetBuildingId },
        select: { createdById: true },
      });
      return building?.createdById ?? null;
    }
    return null;
  }

  /** 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); this is a platform-wide, unbounded queue (`27_Performance_Review_v1.0` §1.3). */
  async listSupportCases(
    filters: {
      status?: CaseStatus;
      priority?: VerificationPriority;
      category?: SupportCaseCategory;
      assignedToId?: string;
    },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: filters.status,
      priority: filters.priority,
      category: filters.category,
      assignedToId: filters.assignedToId,
    };
    const [items, total] = await Promise.all([
      this.prisma.supportCase.findMany({
        where,
        include: { createdBy: { select: { id: true, fullName: true, phone: true } } },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.supportCase.count({ where }),
    ]);
    return { items, total };
  }

  async listSupportCasesForCreator(
    createdById: string,
    pagination: { skip: number; take: number },
  ) {
    const where = { createdById };
    const [items, total] = await Promise.all([
      this.prisma.supportCase.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pagination,
      }),
      this.prisma.supportCase.count({ where }),
    ]);
    return { items, total };
  }

  async assignSupportCase(id: string, assignedToId: string, expectedStatus: CaseStatus) {
    const result = await this.prisma.supportCase.updateMany({
      where: { id, status: expectedStatus },
      data: { assignedToId, status: 'IN_PROGRESS' },
    });
    if (result.count !== 1) throw new ConflictError('Support case status changed; reload and retry.');
    return this.prisma.supportCase.findUniqueOrThrow({ where: { id } });
  }

  updateSupportCaseStatus(id: string, status: CaseStatus) {
    return this.prisma.supportCase.update({
      where: { id },
      data: {
        status,
        resolvedAt: status === 'RESOLVED' ? new Date() : undefined,
        closedAt: status === 'CLOSED' ? new Date() : undefined,
      },
    });
  }

  async resolveSupportCase(params: {
    id: string;
    resolutionCode: SupportCaseResolutionCode;
    resolution?: string;
    expectedStatus: CaseStatus;
  }) {
    const result = await this.prisma.supportCase.updateMany({
      where: { id: params.id, status: params.expectedStatus },
      data: {
        status: 'RESOLVED',
        resolutionCode: params.resolutionCode,
        resolution: params.resolution,
        resolvedAt: new Date(),
      },
    });
    if (result.count !== 1) throw new ConflictError('Support case status changed; reload and retry.');
    return this.prisma.supportCase.findUniqueOrThrow({ where: { id: params.id } });
  }

  async reopenSupportCase(id: string, expectedStatus: CaseStatus) {
    const result = await this.prisma.supportCase.updateMany({
      where: { id, status: expectedStatus },
      data: { status: 'OPEN', resolvedAt: null, closedAt: null },
    });
    if (result.count !== 1) throw new ConflictError('Support case status changed; reload and retry.');
    return this.prisma.supportCase.findUniqueOrThrow({ where: { id } });
  }

  escalateSupportCasePriority(id: string, priority: VerificationPriority) {
    return this.prisma.supportCase.update({ where: { id }, data: { priority } });
  }

  async mergeSupportCase(id: string, mergedIntoId: string, expectedStatus: CaseStatus) {
    const result = await this.prisma.supportCase.updateMany({
      where: { id, status: expectedStatus, mergedIntoId: null },
      data: { mergedIntoId, status: 'CLOSED', closedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictError('Support case changed or was already merged.');
    return this.prisma.supportCase.findUniqueOrThrow({ where: { id } });
  }

  addSupportCaseMessage(params: {
    caseId: string;
    senderId: string;
    body: string;
    isInternal: boolean;
  }) {
    return this.prisma.supportCaseMessage.create({
      data: {
        caseId: params.caseId,
        senderId: params.senderId,
        body: params.body,
        isInternal: params.isInternal,
      },
    });
  }

  /**
   * 21_ADRs > ADR-048 — 07.05 Rule 019/020's own example list ("Resolution
   * Time / Response Time / Reopen Rate / Case Volume"), each read literally
   * from data already recorded, with zero invented formula:
   *  - Case Volume: `groupBy(['category'])` count within the window.
   *  - Resolution Time: avg(`resolvedAt` - `createdAt`) across cases in the
   *    window that HAVE a `resolvedAt` — unresolved cases don't contribute.
   *  - Response Time: avg(first non-internal message NOT from the case's
   *    own creator, minus `createdAt`) — the literal "first time someone
   *    else replied" reading of "response," matching `addStaffMessage`'s
   *    own `isInternal: false` visible-reply shape. A case with no staff
   *    reply yet doesn't contribute.
   *  - Reopen Rate: count of `SupportCaseReopened` audit events in the
   *    window, divided by case volume in the same window — a windowed
   *    ratio, not a per-case cohort trace (the source names the metric,
   *    not its exact denominator).
   * All computed from a single `findMany` plus two small aggregates, the
   * same "fetch + `reduce` in the repository" style `FinanceRepository.
   * getFinancialSummary` already established, since Prisma's `groupBy` has
   * no built-in date-diff aggregate.
   */
  async getSupportCaseMetrics(fromDate?: Date, toDate?: Date) {
    const where = fromDate || toDate ? { createdAt: { gte: fromDate, lte: toDate } } : undefined;

    const [byCategory, reopenCount, cases] = await Promise.all([
      this.prisma.supportCase.groupBy({ by: ['category'], where, _count: { category: true } }),
      this.prisma.auditLog.count({
        where: {
          action: 'SupportCaseReopened',
          entityType: 'SupportCase',
          ...(where ? { createdAt: where.createdAt } : {}),
        },
      }),
      this.prisma.supportCase.findMany({
        where,
        select: {
          createdAt: true,
          resolvedAt: true,
          createdById: true,
          messages: {
            where: { isInternal: false },
            orderBy: { createdAt: 'asc' },
            select: { senderId: true, createdAt: true },
          },
        },
      }),
    ]);

    const totalCaseVolume = byCategory.reduce((sum, g) => sum + g._count.category, 0);

    const resolutionTimesMs = cases
      .filter((c) => c.resolvedAt !== null)
      .map((c) => c.resolvedAt!.getTime() - c.createdAt.getTime());

    const responseTimesMs = cases
      .map((c) => {
        const firstReply = c.messages.find((m) => m.senderId !== c.createdById);
        return firstReply ? firstReply.createdAt.getTime() - c.createdAt.getTime() : null;
      })
      .filter((ms): ms is number => ms !== null);

    const average = (values: number[]) =>
      values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const msToHours = (ms: number | null) => (ms === null ? null : ms / (1000 * 60 * 60));

    return {
      caseVolumeByCategory: byCategory.map((g) => ({
        category: g.category,
        count: g._count.category,
      })),
      totalCaseVolume,
      avgResolutionTimeHours: msToHours(average(resolutionTimesMs)),
      avgResponseTimeHours: msToHours(average(responseTimesMs)),
      reopenRate: totalCaseVolume > 0 ? reopenCount / totalCaseVolume : null,
    };
  }

  // --- Subscription Management (07.04/04.04) -----------------------------

  createSubscription(params: { buildingId: string; trialEndsAt: Date }) {
    return this.prisma.subscription.create({
      data: {
        buildingId: params.buildingId,
        plan: 'FREE',
        status: 'TRIAL',
        trialEndsAt: params.trialEndsAt,
        trialUsed: true,
      },
    });
  }

  findSubscriptionByBuildingId(buildingId: string) {
    return this.prisma.subscription.findUnique({
      where: { buildingId },
      include: {
        featureGrants: { orderBy: { grantedAt: 'desc' } },
      },
    });
  }

  findSubscriptionById(id: string) {
    return this.prisma.subscription.findUnique({ where: { id } });
  }

  /**
   * Subscriptions with a pending time-based transition as of now — the
   * query-side counterpart to `SubscriptionService.evaluateExpiry`'s
   * three conditions (Trial expiry, Active period lapse, Grace Period
   * lapse). Used by the scheduler sweep (21_ADRs > ADR-036); the existing
   * per-building manual endpoint still calls `evaluateExpiry` directly.
   */
  findSubscriptionsDueForEvaluation() {
    const now = new Date();
    return this.prisma.subscription.findMany({
      where: {
        OR: [
          { status: 'TRIAL', trialEndsAt: { lte: now } },
          { status: 'ACTIVE', currentPeriodEndsAt: { lte: now } },
          { status: 'EXPIRED', gracePeriodEndsAt: { lte: now } },
        ],
      },
      select: { buildingId: true },
    });
  }

  updateSubscriptionPlan(id: string, plan: SubscriptionPlan) {
    return this.prisma.subscription.update({ where: { id }, data: { plan } });
  }

  updateSubscriptionStatus(params: {
    id: string;
    status: SubscriptionStatus;
    cancelledAt?: Date;
    gracePeriodEndsAt?: Date | null;
  }) {
    return this.prisma.subscription.update({
      where: { id: params.id },
      data: {
        status: params.status,
        cancelledAt: params.cancelledAt,
        gracePeriodEndsAt: params.gracePeriodEndsAt,
      },
    });
  }

  createSubscriptionChangeLog(params: {
    subscriptionId: string;
    fromPlan?: SubscriptionPlan;
    toPlan?: SubscriptionPlan;
    fromStatus?: SubscriptionStatus;
    toStatus?: SubscriptionStatus;
    changedById?: string;
    reason?: string;
  }) {
    return this.prisma.subscriptionChangeLog.create({
      data: {
        subscriptionId: params.subscriptionId,
        fromPlan: params.fromPlan,
        toPlan: params.toPlan,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        changedById: params.changedById,
        reason: params.reason,
      },
    });
  }

  listSubscriptionHistory(subscriptionId: string) {
    return this.prisma.subscriptionChangeLog.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  createFeatureGrant(params: {
    subscriptionId: string;
    featureKey: SubscriptionFeatureKey;
    grantType: FeatureGrantType;
    reason?: string;
    grantedById: string;
    expiresAt?: Date;
  }) {
    return this.prisma.featureGrant.create({
      data: {
        subscriptionId: params.subscriptionId,
        featureKey: params.featureKey,
        grantType: params.grantType,
        reason: params.reason,
        grantedById: params.grantedById,
        expiresAt: params.expiresAt,
      },
    });
  }

  findFeatureGrantById(id: string) {
    return this.prisma.featureGrant.findUnique({ where: { id } });
  }

  revokeFeatureGrant(id: string, revokedById: string) {
    return this.prisma.featureGrant.update({
      where: { id },
      data: { revokedById, revokedAt: new Date() },
    });
  }

  // --- Audit & Compliance Center — fuller version (07.06, see ADR-034) ---

  createComplianceCase(params: {
    category: ComplianceCaseCategory;
    status?: FraudCaseStatus;
    priority?: VerificationPriority;
    subjectActorId?: string;
    linkedEntityType?: string;
    linkedEntityId?: string;
    sourceAuditLogIds?: string[];
    description: string;
    isAutoDetected?: boolean;
    openedById?: string;
    activeDetectionKey?: string;
  }) {
    return this.prisma.complianceCase.create({
      data: {
        category: params.category,
        status: params.status ?? 'OPEN',
        priority: params.priority ?? 'NORMAL',
        subjectActorId: params.subjectActorId,
        linkedEntityType: params.linkedEntityType,
        linkedEntityId: params.linkedEntityId,
        sourceAuditLogIds: params.sourceAuditLogIds ?? [],
        description: params.description,
        isAutoDetected: params.isAutoDetected ?? false,
        openedById: params.openedById,
        activeDetectionKey: params.activeDetectionKey,
      },
    });
  }

  async createAutoDetectedComplianceCase(params: {
    category: ComplianceCaseCategory;
    subjectActorId: string;
    description: string;
  }) {
    try {
      return await this.createComplianceCase({
        ...params,
        isAutoDetected: true,
        activeDetectionKey: `${params.category}:${params.subjectActorId}`,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  findComplianceCaseById(id: string) {
    return this.prisma.complianceCase.findUnique({ where: { id } });
  }

  /** 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); this is a platform-wide, unbounded queue (`27_Performance_Review_v1.0` §1.3). */
  async listComplianceCases(
    filters: {
      status?: FraudCaseStatus;
      category?: ComplianceCaseCategory;
      priority?: VerificationPriority;
      assignedToId?: string;
      subjectActorId?: string;
    },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: filters.status,
      category: filters.category,
      priority: filters.priority,
      assignedToId: filters.assignedToId,
      subjectActorId: filters.subjectActorId,
    };
    const [items, total] = await Promise.all([
      this.prisma.complianceCase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.complianceCase.count({ where }),
    ]);
    return { items, total };
  }

  listComplianceAssigneeCandidateIds() {
    return this.prisma.platformStaff.findMany({
      select: { personId: true },
      orderBy: { personId: 'asc' },
    });
  }

  findComplianceAssigneeCandidate(personId: string) {
    return this.prisma.platformStaff.findUnique({
      where: { personId },
      select: {
        personId: true,
        isActive: true,
        person: { select: { fullName: true, isSuspended: true } },
      },
    });
  }

  async assignComplianceCase(
    id: string,
    assignedToId: string,
    expectedStatus: FraudCaseStatus,
    expectedAssignedToId: string | null,
  ) {
    const result = await this.prisma.complianceCase.updateMany({
      where: { id, status: expectedStatus, assignedToId: expectedAssignedToId },
      data: { assignedToId, status: 'UNDER_INVESTIGATION' },
    });
    if (result.count !== 1) {
      throw new ConflictError('Compliance case status changed; reload and retry.');
    }
    return this.prisma.complianceCase.findUniqueOrThrow({ where: { id } });
  }

  async decideComplianceCase(params: {
    id: string;
    status: FraudCaseStatus;
    decidedById: string;
    decisionReason?: string;
    expectedStatus: FraudCaseStatus;
    expectedAssignedToId: string | null;
  }) {
    const result = await this.prisma.complianceCase.updateMany({
      where: {
        id: params.id,
        status: params.expectedStatus,
        assignedToId: params.expectedAssignedToId,
      },
      data: {
        status: params.status,
        decidedById: params.decidedById,
        decisionReason: params.decisionReason,
        decidedAt: new Date(),
        activeDetectionKey: null,
      },
    });
    if (result.count !== 1) {
      throw new ConflictError('Compliance case status changed; reload and retry.');
    }
    return this.prisma.complianceCase.findUniqueOrThrow({ where: { id: params.id } });
  }

  // Heuristics for `ComplianceCaseService.detectAnomalies` — one honest,
  // computable-today signal per category, the same "single heuristic, not
  // a full signal set" discipline already disclosed for Building
  // Verification's risk score and Fraud & Abuse's own Rule 001 gap.

  findPersonsWithRepeatedConfirmedFraud(minCount: number) {
    return this.prisma.fraudCase.groupBy({
      by: ['targetPersonId'],
      where: { status: 'CONFIRMED', targetPersonId: { not: null } },
      _count: { targetPersonId: true },
      having: { targetPersonId: { _count: { gte: minCount } } },
    });
  }

  findPersonsWithRepeatedSuspensions(minCount: number) {
    return this.prisma.enforcementAction.groupBy({
      by: ['targetPersonId'],
      where: { type: 'ACCOUNT_SUSPENSION', targetPersonId: { not: null } },
      _count: { targetPersonId: true },
      having: { targetPersonId: { _count: { gte: minCount } } },
    });
  }

  /** Stand-in Financial Anomaly signal: repeated `PaymentRejected` audit events by the same actor. */
  findActorsWithRepeatedRejectedPayments(minCount: number) {
    return this.prisma.auditLog.groupBy({
      by: ['actorId'],
      where: { action: 'PaymentRejected', actorId: { not: null } },
      _count: { actorId: true },
      having: { actorId: { _count: { gte: minCount } } },
    });
  }

  // --- Legal Hold (07.06 Rule 015) ---

  createLegalHold(params: {
    entityType: string;
    entityId: string;
    reason: string;
    placedById: string;
  }) {
    return this.prisma.auditLegalHold.create({ data: params });
  }

  findLegalHoldById(id: string) {
    return this.prisma.auditLegalHold.findUnique({ where: { id } });
  }

  findActiveLegalHold(entityType: string, entityId: string) {
    return this.prisma.auditLegalHold.findFirst({
      where: { entityType, entityId, isActive: true },
    });
  }

  /** 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); this is a platform-wide, unbounded queue (`27_Performance_Review_v1.0` §1.3). */
  async listLegalHolds(
    filters: { entityType?: string; entityId?: string; isActive?: boolean },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      entityType: filters.entityType,
      entityId: filters.entityId,
      isActive: filters.isActive,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLegalHold.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.auditLegalHold.count({ where }),
    ]);
    return { items, total };
  }

  releaseLegalHold(id: string, releasedById: string) {
    return this.prisma.auditLegalHold.update({
      where: { id },
      data: { isActive: false, releasedById, releasedAt: new Date() },
    });
  }
}
