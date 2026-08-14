import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  MonitoringService,
  MonitoringOverview,
} from '../../monitoring/application/monitoring.service';
import type { VerificationPriority } from '@prisma/client';

export interface CountByPriority {
  LOW: number;
  NORMAL: number;
  HIGH: number;
  CRITICAL: number;
}

export interface VerificationQueueSection {
  pending: number;
  pendingByPriority: CountByPriority;
}

export interface TriageStatusSection {
  open: number;
  underInvestigation: number;
  confirmedTotal: number;
  dismissedTotal: number;
}

export interface SupportSection {
  open: number;
  inProgress: number;
  waitingUser: number;
  resolvedTotal: number;
  closedTotal: number;
}

export interface FinanceSection {
  pendingApprovalCount: number;
  pendingApprovalAmount: number;
  approvedTotalAmount: number;
  refundedTotalAmount: number;
  openChargeBatches: number;
}

export interface RecentCriticalAuditEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface DashboardOverview {
  generatedAt: string;
  users: { total: number };
  buildings: { total: number; active: number; pendingVerification: number };
  buildingVerification: VerificationQueueSection;
  managerVerification: VerificationQueueSection;
  fraud: TriageStatusSection;
  compliance: TriageStatusSection;
  support: SupportSection;
  finance: FinanceSection;
  systemHealth: MonitoringOverview | { status: 'unavailable' };
  recentCriticalAuditEvents: RecentCriticalAuditEvent[];
}

/**
 * 21_ADRs > ADR-110 — curated allowlist of `AuditLog.action` values
 * surfaced as "critical" on the dashboard. `AuditLog` has no severity
 * column (see its own schema comment / `AuditService.getMetrics`'s doc
 * comment for why one was never added), so this is a deliberate,
 * hand-picked list rather than a query against a real severity field —
 * every value here was taken from an actual `audit.record({ action:
 * '...' })` call already present in this codebase (never invented), and
 * grouped into five categories that are all either security-sensitive
 * (privilege changes), financially-reversing (money already moved, then
 * undone or returned), or the output of this codebase's own two highest-
 * risk investigative workflows (Fraud, Compliance). Routine business
 * decisions (e.g. `BuildingVerificationDecided`, `ManagerVerificationDecided`)
 * are deliberately excluded — those already have their own dedicated
 * pending-queue counts elsewhere on this same dashboard, so repeating
 * every decision here would bury the genuinely rare, high-risk events
 * this widget exists to surface. See ADR-110 Future Review for the
 * suggestion to replace this allowlist with a real `AuditLog.severity`
 * column if the list becomes hard to keep in sync by hand.
 */
export const CRITICAL_AUDIT_ACTIONS: string[] = [
  // Fraud investigations
  'FraudCaseOpened',
  'FraudCaseDecided',
  'FraudCaseReported',
  // Compliance investigations
  'ComplianceCaseOpened',
  'ComplianceCaseAutoOpened',
  'ComplianceCaseDecided',
  // Consequences of a Fraud/Compliance decision
  'EnforcementActionIssued',
  'EnforcementActionAppealDecided',
  // Legal Hold
  'LegalHoldPlaced',
  'LegalHoldReleased',
  // Platform-wide impact
  'MaintenanceModeEnabled',
  'MaintenanceModeDisabled',
  // Financial reversals — money already moved, then undone or returned
  'PaymentReversed',
  'PaymentRefunded',
  // Privilege changes
  'RolePermissionGranted',
  'RolePermissionRevoked',
  'StaffRoleAssigned',
  'StaffRoleRevoked',
  // Account-level access gate
  'PersonBackofficeApprovalChanged',
  // Finance Hardening Pass (post-audit) — staff-direct administrative
  // overrides (ADR-111 User Administration, ADR-112 Building
  // Administration, ADR-113 Financial Administration). Each of these six
  // actions was named at the time of its own ADR as a real, already-
  // recorded audit action absent from this allowlist despite being a
  // consequential, staff-initiated override of another domain's own
  // state — ADR-111's own text incorrectly claimed the first two were
  // already included; ADR-112 and ADR-113 both correctly flagged the
  // discrepancy and left it as tracked residual debt rather than fixing
  // it outside their own stage's scope. Reconciled here as one batch, per
  // ADR-113's own suggestion ("a single small, separately reviewed change
  // to dashboard.service.ts could reconcile all six at once").
  'PersonSuspendedByAdmin',
  'PersonReinstatedByAdmin',
  'BuildingLockedByAdmin',
  'BuildingReinstatedByAdmin',
  'PaymentReversedByAdmin',
  'PaymentRefundedByAdmin',
];

const RECENT_CRITICAL_AUDIT_EVENTS_LIMIT = 20;

const EMPTY_COUNT_BY_PRIORITY: CountByPriority = { LOW: 0, NORMAL: 0, HIGH: 0, CRITICAL: 0 };

/**
 * 21_ADRs > ADR-110 — Backoffice Operational Dashboard. A single
 * read-only aggregation endpoint over data every other domain already
 * owns — no new business data is introduced here, no domain's own
 * counts are recomputed differently than that domain's own queries would
 * compute them. Every section is fetched independently via
 * `Promise.allSettled` (matching `MonitoringService`'s own aggregation
 * pattern) so a failure in one section's query never takes down the
 * whole response — this endpoint always returns HTTP 200 with whatever
 * sections succeeded, and a documented `null`/empty fallback for
 * whichever section failed, never a 500 for a partial read failure.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly monitoring: MonitoringService,
  ) {}

  async getOverview(): Promise<DashboardOverview> {
    const [
      users,
      buildings,
      buildingVerification,
      managerVerification,
      fraud,
      compliance,
      support,
      finance,
      systemHealth,
      recentCriticalAuditEvents,
    ] = await Promise.allSettled([
      this.getUsersSection(),
      this.getBuildingsSection(),
      this.getBuildingVerificationSection(),
      this.getManagerVerificationSection(),
      this.getFraudSection(),
      this.getComplianceSection(),
      this.getSupportSection(),
      this.getFinanceSection(),
      this.monitoring.getOverview(),
      this.getRecentCriticalAuditEvents(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      users: this.unwrap(users, { total: 0 }, 'users'),
      buildings: this.unwrap(
        buildings,
        { total: 0, active: 0, pendingVerification: 0 },
        'buildings',
      ),
      buildingVerification: this.unwrap(
        buildingVerification,
        { pending: 0, pendingByPriority: EMPTY_COUNT_BY_PRIORITY },
        'buildingVerification',
      ),
      managerVerification: this.unwrap(
        managerVerification,
        { pending: 0, pendingByPriority: EMPTY_COUNT_BY_PRIORITY },
        'managerVerification',
      ),
      fraud: this.unwrap(
        fraud,
        { open: 0, underInvestigation: 0, confirmedTotal: 0, dismissedTotal: 0 },
        'fraud',
      ),
      compliance: this.unwrap(
        compliance,
        { open: 0, underInvestigation: 0, confirmedTotal: 0, dismissedTotal: 0 },
        'compliance',
      ),
      support: this.unwrap(
        support,
        { open: 0, inProgress: 0, waitingUser: 0, resolvedTotal: 0, closedTotal: 0 },
        'support',
      ),
      finance: this.unwrap(
        finance,
        {
          pendingApprovalCount: 0,
          pendingApprovalAmount: 0,
          approvedTotalAmount: 0,
          refundedTotalAmount: 0,
          openChargeBatches: 0,
        },
        'finance',
      ),
      systemHealth: this.unwrap<MonitoringOverview | { status: 'unavailable' }>(
        systemHealth,
        { status: 'unavailable' },
        'systemHealth',
      ),
      recentCriticalAuditEvents: this.unwrap(
        recentCriticalAuditEvents,
        [],
        'recentCriticalAuditEvents',
      ),
    };
  }

  private async getUsersSection(): Promise<{ total: number }> {
    const total = await this.prisma.person.count();
    return { total };
  }

  private async getBuildingsSection(): Promise<{
    total: number;
    active: number;
    pendingVerification: number;
  }> {
    const [total, active, pendingVerification] = await Promise.all([
      this.prisma.building.count(),
      this.prisma.building.count({ where: { status: 'VERIFIED' } }),
      this.prisma.building.count({
        where: { status: { in: ['PENDING', 'UNDER_REVIEW', 'PENDING_INFORMATION'] } },
      }),
    ]);
    return { total, active, pendingVerification };
  }

  private countByPriority(
    rows: Array<{ priority: VerificationPriority; _count: number }>,
  ): CountByPriority {
    const byPriority: CountByPriority = { ...EMPTY_COUNT_BY_PRIORITY };
    for (const row of rows) {
      byPriority[row.priority] = row._count;
    }
    return byPriority;
  }

  /** `BuildingVerificationCase`'s own `decision` field (nullable until a
   * staff member decides, per that model's own schema comment) is the
   * "pending" predicate here — deliberately not `status`, which also
   * holds non-decision transitional values. */
  private async getBuildingVerificationSection(): Promise<VerificationQueueSection> {
    const where = { decision: null };
    const [pending, byPriority] = await Promise.all([
      this.prisma.buildingVerificationCase.count({ where }),
      this.prisma.buildingVerificationCase.groupBy({ by: ['priority'], where, _count: true }),
    ]);
    return { pending, pendingByPriority: this.countByPriority(byPriority) };
  }

  /** `ManagerVerificationCase.status`'s only non-terminal value is
   * `PENDING` (`VERIFIED`/`REJECTED`/`SUSPENDED` are all terminal), so
   * unlike Building Verification this can use `status` directly. */
  private async getManagerVerificationSection(): Promise<VerificationQueueSection> {
    const where = { status: 'PENDING' as const };
    const [pending, byPriority] = await Promise.all([
      this.prisma.managerVerificationCase.count({ where }),
      this.prisma.managerVerificationCase.groupBy({ by: ['priority'], where, _count: true }),
    ]);
    return { pending, pendingByPriority: this.countByPriority(byPriority) };
  }

  private toTriageStatusSection(
    rows: Array<{ status: string; _count: number }>,
  ): TriageStatusSection {
    const byStatus = new Map(rows.map((row) => [row.status, row._count]));
    return {
      open: byStatus.get('OPEN') ?? 0,
      underInvestigation: byStatus.get('UNDER_INVESTIGATION') ?? 0,
      confirmedTotal: byStatus.get('CONFIRMED') ?? 0,
      dismissedTotal: byStatus.get('DISMISSED') ?? 0,
    };
  }

  private async getFraudSection(): Promise<TriageStatusSection> {
    const rows = await this.prisma.fraudCase.groupBy({ by: ['status'], _count: true });
    return this.toTriageStatusSection(rows);
  }

  /** `ComplianceCase.status` reuses the exact same `FraudCaseStatus` enum as `FraudCase` (see that field's own schema comment for why), so the same mapping applies. */
  private async getComplianceSection(): Promise<TriageStatusSection> {
    const rows = await this.prisma.complianceCase.groupBy({ by: ['status'], _count: true });
    return this.toTriageStatusSection(rows);
  }

  private async getSupportSection(): Promise<SupportSection> {
    const rows = await this.prisma.supportCase.groupBy({ by: ['status'], _count: true });
    const byStatus = new Map(rows.map((row) => [row.status, row._count]));
    return {
      open: byStatus.get('OPEN') ?? 0,
      inProgress: byStatus.get('IN_PROGRESS') ?? 0,
      waitingUser: byStatus.get('WAITING_USER') ?? 0,
      resolvedTotal: byStatus.get('RESOLVED') ?? 0,
      closedTotal: byStatus.get('CLOSED') ?? 0,
    };
  }

  /**
   * Deliberately simple, directly-defined aggregates only — a "sum of
   * APPROVED payment amounts" and similar are unambiguous, real facts
   * this data already supports. This does NOT attempt an "outstanding
   * balance owed" or "net revenue after refunds" style derived metric —
   * those require domain rules (proration, allocation order, per-unit
   * vs. per-building rounding) this dashboard has no business
   * re-deriving independently of the Finance module's own logic. See
   * ADR-110 Non-Goals.
   */
  private async getFinanceSection(): Promise<FinanceSection> {
    const [pendingApproval, approved, refunded, openChargeBatches] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: 'PENDING_APPROVAL' },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { status: 'APPROVED' },
        _sum: { amount: true },
      }),
      this.prisma.refund.aggregate({ _sum: { amount: true } }),
      this.prisma.chargeBatch.count({ where: { status: 'ISSUED' } }),
    ]);

    return {
      pendingApprovalCount: pendingApproval._count,
      pendingApprovalAmount: pendingApproval._sum.amount ?? 0,
      approvedTotalAmount: approved._sum.amount ?? 0,
      refundedTotalAmount: refunded._sum.amount ?? 0,
      openChargeBatches,
    };
  }

  private async getRecentCriticalAuditEvents(): Promise<RecentCriticalAuditEvent[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { in: CRITICAL_AUDIT_ACTIONS } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_CRITICAL_AUDIT_EVENTS_LIMIT,
      // Deliberately NOT selecting `metadata` — a dashboard glance-view
      // has no business surfacing whatever free-form detail a specific
      // domain chose to log; `buildingId`/`requestId` are also omitted
      // as not useful at this summary level. A staff member who needs
      // the full record already has the real Audit Center search/
      // timeline endpoints (ADR-029/ADR-034) for that.
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorId: true,
        reason: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorId: row.actorId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private unwrap<T>(result: PromiseSettledResult<T>, fallback: T, sectionName: string): T {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    this.logger.error(
      `Dashboard section "${sectionName}" failed to load — returning fallback.`,
      (result.reason as Error)?.stack,
    );
    return fallback;
  }
}
