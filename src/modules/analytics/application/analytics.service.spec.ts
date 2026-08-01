import { AnalyticsService, ANALYTICS_MAX_RANGE_DAYS } from './analytics.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { GamificationService } from '../../gamification/application/gamification.service';
import { ValidationError } from '../../../common/errors/app-error';

function makePrisma(
  overrides: {
    persons?: Array<{ createdAt: Date }>;
    buildings?: Array<{ createdAt: Date }>;
    payments?: Array<{ approvedAt: Date; amount: number }>;
    xpTransactions?: Array<{ createdAt: Date; amount: number }>;
  } = {},
) {
  return {
    person: { findMany: jest.fn().mockResolvedValue(overrides.persons ?? []) },
    building: { findMany: jest.fn().mockResolvedValue(overrides.buildings ?? []) },
    payment: { findMany: jest.fn().mockResolvedValue(overrides.payments ?? []) },
    xpTransaction: { findMany: jest.fn().mockResolvedValue(overrides.xpTransactions ?? []) },
  } as unknown as PrismaService;
}

const GAMIFICATION_RESULT = {
  xpByReason: [{ reason: 'CHARGE_PAID', totalAmount: 100, transactionCount: 5 }],
  leagueDistribution: [{ tier: 'BRONZE', buildingCount: 3 }],
  weeklyActiveParticipants: 7,
};

function makeGamification(): GamificationService {
  return {
    getAnalytics: jest.fn().mockResolvedValue(GAMIFICATION_RESULT),
  } as unknown as GamificationService;
}

describe('AnalyticsService', () => {
  describe('getGrowth — date range resolution', () => {
    it('defaults to a trailing 30-day range (30 zero-filled buckets) when no params are given', async () => {
      const prisma = makePrisma();
      const gamification = makeGamification();
      const service = new AnalyticsService(prisma, gamification);

      const result = await service.getGrowth();

      expect(result.newUsers).toHaveLength(30);
      expect(result.newBuildings).toHaveLength(30);
      expect(result.paymentsApproved).toHaveLength(30);
      expect(result.xpAwarded).toHaveLength(30);
      expect(result.newUsers.every((row) => row.count === 0)).toBe(true);
    });

    it('accepts an explicit fromDate/toDate range', async () => {
      const prisma = makePrisma();
      const gamification = makeGamification();
      const service = new AnalyticsService(prisma, gamification);

      const result = await service.getGrowth('2026-07-01', '2026-07-05');

      expect(result.fromDate).toBe('2026-07-01');
      expect(result.toDate).toBe('2026-07-05');
      expect(result.newUsers).toHaveLength(5);
      expect(result.newUsers.map((r) => r.date)).toEqual([
        '2026-07-01',
        '2026-07-02',
        '2026-07-03',
        '2026-07-04',
        '2026-07-05',
      ]);
    });

    it('throws ValidationError when fromDate is after toDate', async () => {
      const service = new AnalyticsService(makePrisma(), makeGamification());

      await expect(service.getGrowth('2026-07-10', '2026-07-01')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('throws ValidationError when the range exceeds the max', async () => {
      const service = new AnalyticsService(makePrisma(), makeGamification());

      await expect(service.getGrowth('2026-01-01', '2026-12-31')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('accepts a range at exactly the max boundary', async () => {
      const service = new AnalyticsService(makePrisma(), makeGamification());
      const result = await service.getGrowth('2026-01-01', '2026-03-31');
      expect(result.newUsers).toHaveLength(ANALYTICS_MAX_RANGE_DAYS);
    });

    it('throws ValidationError for an unparseable fromDate', async () => {
      const service = new AnalyticsService(makePrisma(), makeGamification());
      await expect(service.getGrowth('not-a-date', '2026-07-05')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('getGrowth — bucketing', () => {
    it('correctly counts/sums rows into their own day bucket', async () => {
      const prisma = makePrisma({
        persons: [
          { createdAt: new Date('2026-07-02T03:00:00.000Z') },
          { createdAt: new Date('2026-07-02T23:59:00.000Z') },
          { createdAt: new Date('2026-07-04T12:00:00.000Z') },
        ],
        payments: [
          { approvedAt: new Date('2026-07-03T10:00:00.000Z'), amount: 1000 },
          { approvedAt: new Date('2026-07-03T15:00:00.000Z'), amount: 500 },
        ],
        xpTransactions: [{ createdAt: new Date('2026-07-01T00:00:00.000Z'), amount: 20 }],
      });
      const service = new AnalyticsService(prisma, makeGamification());

      const result = await service.getGrowth('2026-07-01', '2026-07-05');

      expect(result.newUsers).toEqual([
        { date: '2026-07-01', count: 0 },
        { date: '2026-07-02', count: 2 },
        { date: '2026-07-03', count: 0 },
        { date: '2026-07-04', count: 1 },
        { date: '2026-07-05', count: 0 },
      ]);
      expect(result.paymentsApproved.find((r) => r.date === '2026-07-03')).toEqual({
        date: '2026-07-03',
        count: 2,
        totalAmount: 1500,
      });
      expect(result.xpAwarded.find((r) => r.date === '2026-07-01')).toEqual({
        date: '2026-07-01',
        count: 1,
        totalAmount: 20,
      });
    });
  });

  describe('getGrowth — gamification reuse', () => {
    it('returns the literal, unmodified GamificationService.getAnalytics() result and passes the resolved range through', async () => {
      const gamification = makeGamification();
      const service = new AnalyticsService(makePrisma(), gamification);

      const result = await service.getGrowth('2026-07-01', '2026-07-05');

      expect(result.gamification).toEqual(GAMIFICATION_RESULT);
      expect(gamification.getAnalytics).toHaveBeenCalledTimes(1);
      const [from, to] = (gamification.getAnalytics as jest.Mock).mock.calls[0];
      expect(from.toISOString().slice(0, 10)).toBe('2026-07-01');
      expect(to.toISOString().slice(0, 10)).toBe('2026-07-05');
    });
  });
});
