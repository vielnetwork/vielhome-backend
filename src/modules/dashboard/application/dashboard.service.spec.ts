import { DashboardService, CRITICAL_AUDIT_ACTIONS } from './dashboard.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  MonitoringService,
  MonitoringOverview,
} from '../../monitoring/application/monitoring.service';

/**
 * 21_ADRs > ADR-110 — Backoffice Operational Dashboard. Prisma and
 * MonitoringService are both fully mocked — these tests exercise the
 * aggregation-shaping contract (countByPriority/toTriageStatusSection),
 * the per-section fallback behavior (`unwrap`), and the finance
 * null-sum-to-zero coercion, not real infra. The single behavior ADR-110
 * explicitly requires and every other Backoffice aggregation endpoint
 * already established (ADR-108's `MonitoringService`): one section's
 * rejection must never reject `getOverview()` as a whole, and must never
 * take any other section down with it.
 */
describe('DashboardService', () => {
  let prisma: {
    person: { count: jest.Mock };
    building: { count: jest.Mock };
    buildingVerificationCase: { count: jest.Mock; groupBy: jest.Mock };
    managerVerificationCase: { count: jest.Mock; groupBy: jest.Mock };
    fraudCase: { groupBy: jest.Mock };
    complianceCase: { groupBy: jest.Mock };
    supportCase: { groupBy: jest.Mock };
    payment: { aggregate: jest.Mock };
    refund: { aggregate: jest.Mock };
    chargeBatch: { count: jest.Mock };
    auditLog: { findMany: jest.Mock };
  };
  let monitoring: { getOverview: jest.Mock };
  let service: DashboardService;

  const HEALTHY_SYSTEM_HEALTH = { status: 'healthy' } as unknown as MonitoringOverview;

  beforeEach(() => {
    prisma = {
      person: { count: jest.fn().mockResolvedValue(0) },
      building: { count: jest.fn().mockResolvedValue(0) },
      buildingVerificationCase: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      managerVerificationCase: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      fraudCase: { groupBy: jest.fn().mockResolvedValue([]) },
      complianceCase: { groupBy: jest.fn().mockResolvedValue([]) },
      supportCase: { groupBy: jest.fn().mockResolvedValue([]) },
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: { amount: null } }),
      },
      refund: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
      chargeBatch: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    };
    monitoring = { getOverview: jest.fn().mockResolvedValue(HEALTHY_SYSTEM_HEALTH) };
    service = new DashboardService(
      prisma as unknown as PrismaService,
      monitoring as unknown as MonitoringService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('aggregates every section from its own real query, unmodified', async () => {
      prisma.person.count.mockResolvedValue(120);
      prisma.building.count.mockImplementation(
        ({ where }: { where?: Record<string, unknown> } = {}) => {
          if (!where) return Promise.resolve(50);
          if ((where as { status?: unknown }).status === 'VERIFIED') return Promise.resolve(40);
          return Promise.resolve(6);
        },
      );
      prisma.buildingVerificationCase.count.mockResolvedValue(3);
      prisma.buildingVerificationCase.groupBy.mockResolvedValue([
        { priority: 'HIGH', _count: 2 },
        { priority: 'NORMAL', _count: 1 },
      ]);
      prisma.managerVerificationCase.count.mockResolvedValue(1);
      prisma.managerVerificationCase.groupBy.mockResolvedValue([
        { priority: 'CRITICAL', _count: 1 },
      ]);
      prisma.fraudCase.groupBy.mockResolvedValue([
        { status: 'OPEN', _count: 4 },
        { status: 'UNDER_INVESTIGATION', _count: 2 },
      ]);
      prisma.complianceCase.groupBy.mockResolvedValue([{ status: 'DISMISSED', _count: 5 }]);
      prisma.supportCase.groupBy.mockResolvedValue([
        { status: 'OPEN', _count: 7 },
        { status: 'CLOSED', _count: 12 },
      ]);
      prisma.payment.aggregate.mockImplementation(
        ({ where }: { where?: { status?: string } } = {}) => {
          if (where?.status === 'PENDING_APPROVAL') {
            return Promise.resolve({ _count: 3, _sum: { amount: 900_000 } });
          }
          if (where?.status === 'APPROVED') {
            return Promise.resolve({ _count: 5, _sum: { amount: 2_000_000 } });
          }
          return Promise.resolve({ _count: 0, _sum: { amount: null } });
        },
      );
      prisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 150_000 } });
      prisma.chargeBatch.count.mockResolvedValue(9);
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          action: 'FraudCaseDecided',
          entityType: 'FraudCase',
          entityId: 'case-1',
          actorId: 'person-1',
          reason: 'confirmed',
          createdAt,
        },
      ]);

      const result = await service.getOverview();

      expect(result.users).toEqual({ total: 120 });
      expect(result.buildings).toEqual({ total: 50, active: 40, pendingVerification: 6 });
      expect(result.buildingVerification).toEqual({
        pending: 3,
        pendingByPriority: { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 0 },
      });
      expect(result.managerVerification).toEqual({
        pending: 1,
        pendingByPriority: { LOW: 0, NORMAL: 0, HIGH: 0, CRITICAL: 1 },
      });
      expect(result.fraud).toEqual({
        open: 4,
        underInvestigation: 2,
        confirmedTotal: 0,
        dismissedTotal: 0,
      });
      expect(result.compliance).toEqual({
        open: 0,
        underInvestigation: 0,
        confirmedTotal: 0,
        dismissedTotal: 5,
      });
      expect(result.support).toEqual({
        open: 7,
        inProgress: 0,
        waitingUser: 0,
        resolvedTotal: 0,
        closedTotal: 12,
      });
      expect(result.finance).toEqual({
        pendingApprovalCount: 3,
        pendingApprovalAmount: 900_000,
        approvedTotalAmount: 2_000_000,
        refundedTotalAmount: 150_000,
        openChargeBatches: 9,
      });
      expect(result.systemHealth).toBe(HEALTHY_SYSTEM_HEALTH);
      expect(result.recentCriticalAuditEvents).toEqual([
        {
          id: 'log-1',
          action: 'FraudCaseDecided',
          entityType: 'FraudCase',
          entityId: 'case-1',
          actorId: 'person-1',
          reason: 'confirmed',
          createdAt: createdAt.toISOString(),
        },
      ]);
      expect(typeof result.generatedAt).toBe('string');
    });

    it('queries buildingVerificationCase pending strictly by decision: null, never by status', async () => {
      await service.getOverview();
      expect(prisma.buildingVerificationCase.count).toHaveBeenCalledWith({
        where: { decision: null },
      });
      expect(prisma.buildingVerificationCase.groupBy).toHaveBeenCalledWith({
        by: ['priority'],
        where: { decision: null },
        _count: true,
      });
    });

    it('queries managerVerificationCase pending strictly by status: PENDING', async () => {
      await service.getOverview();
      expect(prisma.managerVerificationCase.count).toHaveBeenCalledWith({
        where: { status: 'PENDING' },
      });
    });

    it('scopes the recent critical audit query to the curated allowlist only', async () => {
      await service.getOverview();
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { action: { in: CRITICAL_AUDIT_ACTIONS } } }),
      );
    });

    it('never selects AuditLog.metadata for the dashboard glance view', async () => {
      await service.getOverview();
      const call = prisma.auditLog.findMany.mock.calls[0][0];
      expect(call.select).not.toHaveProperty('metadata');
    });
  });

  describe('finance null-sum coercion', () => {
    it('coerces a null Prisma aggregate sum (no matching rows) to 0, not null', async () => {
      const result = await service.getOverview();
      expect(result.finance.pendingApprovalAmount).toBe(0);
      expect(result.finance.approvedTotalAmount).toBe(0);
      expect(result.finance.refundedTotalAmount).toBe(0);
    });
  });

  describe('partial-failure isolation (Promise.allSettled contract)', () => {
    it('falls back to the documented empty shape for one rejected section, and still returns 200-shaped data for the rest', async () => {
      prisma.person.count.mockRejectedValue(new Error('db down'));
      prisma.building.count.mockResolvedValue(10);

      const result = await service.getOverview();

      expect(result.users).toEqual({ total: 0 });
      expect(result.buildings.total).toBe(10);
    });

    it('falls back systemHealth to { status: "unavailable" } if MonitoringService rejects', async () => {
      monitoring.getOverview.mockRejectedValue(new Error('monitoring aggregation failed'));

      const result = await service.getOverview();

      expect(result.systemHealth).toEqual({ status: 'unavailable' });
    });

    it('falls back recentCriticalAuditEvents to [] if the audit query rejects', async () => {
      prisma.auditLog.findMany.mockRejectedValue(new Error('query failed'));

      const result = await service.getOverview();

      expect(result.recentCriticalAuditEvents).toEqual([]);
    });

    it('never rejects getOverview() itself even when every section rejects', async () => {
      prisma.person.count.mockRejectedValue(new Error('a'));
      prisma.building.count.mockRejectedValue(new Error('b'));
      prisma.buildingVerificationCase.count.mockRejectedValue(new Error('c'));
      prisma.managerVerificationCase.count.mockRejectedValue(new Error('d'));
      prisma.fraudCase.groupBy.mockRejectedValue(new Error('e'));
      prisma.complianceCase.groupBy.mockRejectedValue(new Error('f'));
      prisma.supportCase.groupBy.mockRejectedValue(new Error('g'));
      prisma.payment.aggregate.mockRejectedValue(new Error('h'));
      monitoring.getOverview.mockRejectedValue(new Error('i'));
      prisma.auditLog.findMany.mockRejectedValue(new Error('j'));

      await expect(service.getOverview()).resolves.toBeDefined();
    });
  });
});
