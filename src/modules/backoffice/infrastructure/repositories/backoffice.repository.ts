import { Injectable } from '@nestjs/common';
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
  SubscriptionFeatureKey,
  SubscriptionPlan,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCaseResolutionCode,
  VerificationPriority,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

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
      include: { building: { select: { id: true, name: true, addressLine: true, createdById: true } } },
    });
  }

  /** Most recent case for a building — used to find the case an appeal should link back to, and to enforce "at most one open case at a time." */
  getLatestBuildingVerificationCase(buildingId: string) {
    return this.prisma.buildingVerificationCase.findFirst({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
  }

  listBuildingVerificationCases(filters: { status?: BuildingStatus; priority?: VerificationPriority; assignedToId?: string }) {
    return this.prisma.buildingVerificationCase.findMany({
      where: {
        status: filters.status,
        priority: filters.priority,
        assignedToId: filters.assignedToId,
      },
      include: { building: { select: { id: true, name: true, addressLine: true, city: true } } },
      // 07.01 Rule 012: Queue Ordered By Priority Then Age.
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  assignBuildingVerificationCase(id: string, assignedToId: string) {
    return this.prisma.buildingVerificationCase.update({ where: { id }, data: { assignedToId } });
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

  listManagerVerificationCases(filters: { status?: ManagerVerificationStatus; priority?: VerificationPriority }) {
    return this.prisma.managerVerificationCase.findMany({
      where: { status: filters.status, priority: filters.priority },
      include: {
        building: { select: { id: true, name: true } },
        candidate: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
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
      },
    });
  }

  listFraudCases(filters: { status?: FraudCaseStatus; priority?: VerificationPriority; assignedToId?: string }) {
    return this.prisma.fraudCase.findMany({
      where: {
        status: filters.status,
        priority: filters.priority,
        assignedToId: filters.assignedToId,
      },
      include: {
        targetPerson: { select: { id: true, fullName: true, phone: true } },
        targetBuilding: { select: { id: true, name: true } },
      },
      // 07.03 Rule 004/009: priority-ordered queue, same convention as
      // Building/Manager Verification.
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  assignFraudCase(id: string, assignedToId: string) {
    return this.prisma.fraudCase.update({ where: { id }, data: { assignedToId, status: 'UNDER_INVESTIGATION' } });
  }

  addFraudCaseEvidence(id: string, evidenceNotes: string) {
    return this.prisma.fraudCase.update({ where: { id }, data: { evidenceNotes } });
  }

  decideFraudCase(params: { id: string; status: FraudCaseStatus; reviewedById: string; reason?: string }) {
    return this.prisma.fraudCase.update({
      where: { id: params.id },
      data: {
        status: params.status,
        reviewedById: params.reviewedById,
        reason: params.reason,
        decidedAt: new Date(),
      },
    });
  }

  createEnforcementAction(params: {
    fraudCaseId: string;
    type: EnforcementActionType;
    targetType: EnforcementTargetType;
    targetPersonId?: string;
    targetBuildingId?: string;
    targetMembershipId?: string;
    reason?: string;
    issuedById: string;
  }) {
    return this.prisma.enforcementAction.create({
      data: {
        fraudCaseId: params.fraudCaseId,
        type: params.type,
        targetType: params.targetType,
        targetPersonId: params.targetPersonId,
        targetBuildingId: params.targetBuildingId,
        targetMembershipId: params.targetMembershipId,
        reason: params.reason,
        issuedById: params.issuedById,
      },
    });
  }

  findEnforcementActionById(id: string) {
    return this.prisma.enforcementAction.findUnique({ where: { id } });
  }

  listEnforcementActionsForCase(fraudCaseId: string) {
    return this.prisma.enforcementAction.findMany({ where: { fraudCaseId }, orderBy: { issuedAt: 'asc' } });
  }

  requestEnforcementAppeal(id: string, appealReason?: string) {
    return this.prisma.enforcementAction.update({
      where: { id },
      data: { appealStatus: 'PENDING', appealReason, appealedAt: new Date() },
    });
  }

  decideEnforcementAppeal(params: {
    id: string;
    appealStatus: EnforcementAppealStatus;
    appealDecidedById: string;
  }) {
    return this.prisma.enforcementAction.update({
      where: { id: params.id },
      data: {
        appealStatus: params.appealStatus,
        appealDecidedById: params.appealDecidedById,
        appealDecidedAt: new Date(),
      },
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

    const investigationTimesMs = decidedCases.map((c) => c.decidedAt!.getTime() - c.createdAt.getTime());
    const average = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);
    const msToHours = (ms: number | null) => (ms === null ? null : ms / (1000 * 60 * 60));

    return {
      decidedCaseCount: decidedTotal,
      confirmedCount,
      dismissedCount,
      // Fraction of decided cases confirmed as real fraud, within the window.
      fraudRate: decidedTotal > 0 ? confirmedCount / decidedTotal : null,
      // Fraction of decided USER_REPORT cases that turned out NOT to be fraud (DISMISSED), within the window.
      falseReportRate: userReportDecidedTotal > 0 ? userReportDismissed / userReportDecidedTotal : null,
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

  listSupportCases(filters: {
    status?: CaseStatus;
    priority?: VerificationPriority;
    category?: SupportCaseCategory;
    assignedToId?: string;
  }) {
    return this.prisma.supportCase.findMany({
      where: {
        status: filters.status,
        priority: filters.priority,
        category: filters.category,
        assignedToId: filters.assignedToId,
      },
      include: { createdBy: { select: { id: true, fullName: true, phone: true } } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  listSupportCasesForCreator(createdById: string) {
    return this.prisma.supportCase.findMany({
      where: { createdById },
      orderBy: { createdAt: 'desc' },
    });
  }

  assignSupportCase(id: string, assignedToId: string) {
    return this.prisma.supportCase.update({ where: { id }, data: { assignedToId, status: 'IN_PROGRESS' } });
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

  resolveSupportCase(params: { id: string; resolutionCode: SupportCaseResolutionCode; resolution?: string }) {
    return this.prisma.supportCase.update({
      where: { id: params.id },
      data: {
        status: 'RESOLVED',
        resolutionCode: params.resolutionCode,
        resolution: params.resolution,
        resolvedAt: new Date(),
      },
    });
  }

  reopenSupportCase(id: string) {
    return this.prisma.supportCase.update({
      where: { id },
      data: { status: 'OPEN', resolvedAt: null, closedAt: null },
    });
  }

  escalateSupportCasePriority(id: string, priority: VerificationPriority) {
    return this.prisma.supportCase.update({ where: { id }, data: { priority } });
  }

  mergeSupportCase(id: string, mergedIntoId: string) {
    return this.prisma.supportCase.update({
      where: { id },
      data: { mergedIntoId, status: 'CLOSED', closedAt: new Date() },
    });
  }

  addSupportCaseMessage(params: { caseId: string; senderId: string; body: string; isInternal: boolean }) {
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
        where: { action: 'SupportCaseReopened', entityType: 'SupportCase', ...(where ? { createdAt: where.createdAt } : {}) },
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

    const average = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);
    const msToHours = (ms: number | null) => (ms === null ? null : ms / (1000 * 60 * 60));

    return {
      caseVolumeByCategory: byCategory.map((g) => ({ category: g.category, count: g._count.category })),
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

  updateSubscriptionStatus(params: { id: string; status: SubscriptionStatus; cancelledAt?: Date; gracePeriodEndsAt?: Date | null }) {
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
      },
    });
  }

  findComplianceCaseById(id: string) {
    return this.prisma.complianceCase.findUnique({ where: { id } });
  }

  listComplianceCases(filters: {
    status?: FraudCaseStatus;
    category?: ComplianceCaseCategory;
    priority?: VerificationPriority;
    assignedToId?: string;
    subjectActorId?: string;
  }) {
    return this.prisma.complianceCase.findMany({
      where: {
        status: filters.status,
        category: filters.category,
        priority: filters.priority,
        assignedToId: filters.assignedToId,
        subjectActorId: filters.subjectActorId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Used by `detectAnomalies` to avoid opening a duplicate case for the same still-open pattern. */
  findOpenComplianceCaseFor(category: ComplianceCaseCategory, subjectActorId: string) {
    return this.prisma.complianceCase.findFirst({
      where: { category, subjectActorId, status: { in: ['OPEN', 'UNDER_INVESTIGATION'] } },
    });
  }

  assignComplianceCase(id: string, assignedToId: string) {
    return this.prisma.complianceCase.update({ where: { id }, data: { assignedToId, status: 'UNDER_INVESTIGATION' } });
  }

  decideComplianceCase(params: { id: string; status: FraudCaseStatus; decidedById: string; decisionReason?: string }) {
    return this.prisma.complianceCase.update({
      where: { id: params.id },
      data: {
        status: params.status,
        decidedById: params.decidedById,
        decisionReason: params.decisionReason,
        decidedAt: new Date(),
      },
    });
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

  createLegalHold(params: { entityType: string; entityId: string; reason: string; placedById: string }) {
    return this.prisma.auditLegalHold.create({ data: params });
  }

  findLegalHoldById(id: string) {
    return this.prisma.auditLegalHold.findUnique({ where: { id } });
  }

  findActiveLegalHold(entityType: string, entityId: string) {
    return this.prisma.auditLegalHold.findFirst({ where: { entityType, entityId, isActive: true } });
  }

  listLegalHolds(filters: { entityType?: string; entityId?: string; isActive?: boolean }) {
    return this.prisma.auditLegalHold.findMany({
      where: { entityType: filters.entityType, entityId: filters.entityId, isActive: filters.isActive },
      orderBy: { placedAt: 'desc' },
    });
  }

  releaseLegalHold(id: string, releasedById: string) {
    return this.prisma.auditLegalHold.update({
      where: { id },
      data: { isActive: false, releasedById, releasedAt: new Date() },
    });
  }
}
