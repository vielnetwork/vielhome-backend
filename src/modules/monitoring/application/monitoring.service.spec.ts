import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { MonitoringService } from './monitoring.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StorageService } from '../../../common/storage/storage.service';
import type { AppConfig } from '../../../config/configuration';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));
import Redis from 'ioredis';

function makeRedisMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    info: jest.fn().mockImplementation((section: string) => {
      switch (section) {
        case 'server':
          return Promise.resolve('# Server\r\nredis_version:7.2.0\r\nuptime_in_seconds:12345\r\n');
        case 'memory':
          return Promise.resolve('# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\n');
        case 'clients':
          return Promise.resolve('# Clients\r\nconnected_clients:3\r\n');
        case 'replication':
          return Promise.resolve('# Replication\r\nrole:master\r\n');
        default:
          return Promise.resolve('');
      }
    }),
    dbsize: jest.fn().mockResolvedValue(42),
    disconnect: jest.fn(),
    ...overrides,
  };
}

function makeQueueMock(overrides: Partial<Record<string, jest.Mock>> = {}): Queue {
  return {
    getJobCounts: jest
      .fn()
      .mockResolvedValue({ waiting: 0, active: 0, delayed: 0, completed: 5, failed: 0, paused: 0 }),
    isPaused: jest.fn().mockResolvedValue(false),
    getWorkers: jest.fn().mockResolvedValue([{ id: 'w1' }]),
    getJobs: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Queue;
}

function makeConfig(): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => {
      if (key === 'redis.host') return 'localhost';
      if (key === 'redis.port') return 6379;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

const HEALTHY_DB_ACTIVITY_ROW = [{ active: 0n, idle: 0n, idle_in_transaction: 0n, total: 0n }];

/**
 * 21_ADRs > ADR-108 — Backoffice Monitoring & System Health. These tests
 * exercise the aggregation/isolation contract, not real infra: Prisma,
 * ioredis, Storage, and both Queues are fully mocked. The behaviors under
 * test are the ones ADR-108 explicitly requires: one dependency's failure
 * must never reject `getOverview()` or crash the others; hard dependencies
 * (database/redis) escalate the overall status to `unhealthy`, soft ones
 * (storage/queues/scheduler) only ever reach `degraded`; and no raw
 * secrets/INFO output/failedReason ever appears in the response.
 */
describe('MonitoringService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let storage: { checkBucketHealth: jest.Mock };
  let schedulerQueue: Queue;
  let notificationQueue: Queue;
  let service: MonitoringService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = { $queryRaw: jest.fn() };
    storage = {
      checkBucketHealth: jest
        .fn()
        .mockResolvedValue({ configured: true, reachable: true, bucketAccessible: true }),
    };
    schedulerQueue = makeQueueMock();
    notificationQueue = makeQueueMock();
    (Redis as unknown as jest.Mock).mockImplementation(() => makeRedisMock());

    service = new MonitoringService(
      prisma as unknown as PrismaService,
      makeConfig(),
      storage as unknown as StorageService,
      schedulerQueue,
      notificationQueue,
    );
  });

  function mockHealthyDatabase() {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce(HEALTHY_DB_ACTIVITY_ROW);
  }

  describe('getOverview — happy path', () => {
    it('returns a fully healthy snapshot when every dependency is up', async () => {
      mockHealthyDatabase();

      const result = await service.getOverview();

      expect(result.status).toBe('healthy');
      expect(result.database.status).toBe('healthy');
      expect(result.database.databaseConnections).toEqual({
        metricsAvailable: true,
        active: 0,
        idle: 0,
        idleInTransaction: 0,
        total: 0,
      });
      expect(result.redis.status).toBe('healthy');
      expect(result.redis.keyCount).toBe(42);
      expect(result.redis.role).toBe('master');
      expect(result.storage.status).toBe('healthy');
      expect(result.queues).toHaveLength(2);
      expect(result.queues.map((q) => q.name).sort()).toEqual(
        ['notification-dispatch', 'scheduled-jobs'].sort(),
      );
      expect(result.queues.every((q) => q.status === 'healthy')).toBe(true);
      expect(result.scheduler.status).toBe('healthy');
      expect(typeof result.checkedAt).toBe('string');
      expect(() => new Date(result.checkedAt).toISOString()).not.toThrow();
    });
  });

  describe('database isolation', () => {
    it('marks overall status unhealthy when the database is down, but never throws and never takes down other sections', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      const result = await service.getOverview();

      expect(result.status).toBe('unhealthy');
      expect(result.database.status).toBe('unhealthy');
      expect(result.database.connected).toBe(false);
      expect(result.database.databaseConnections).toEqual({ metricsAvailable: false });
      expect(result.redis.status).toBe('healthy');
      expect(result.storage.status).toBe('healthy');
    });

    it('reports metricsAvailable:false (not unhealthy) when connectivity succeeds but the activity query fails', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockRejectedValueOnce(new Error('permission denied for pg_stat_activity'));

      const result = await service.getOverview();

      expect(result.database.status).toBe('healthy');
      expect(result.database.connected).toBe(true);
      expect(result.database.databaseConnections).toEqual({ metricsAvailable: false });
      expect(result.status).toBe('healthy');
    });
  });

  describe('redis isolation', () => {
    it('marks overall status unhealthy when Redis is unreachable, without affecting the database section', async () => {
      mockHealthyDatabase();
      (Redis as unknown as jest.Mock).mockImplementation(() =>
        makeRedisMock({ connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
      );

      const result = await service.getOverview();

      expect(result.status).toBe('unhealthy');
      expect(result.redis.status).toBe('unhealthy');
      expect(result.redis.connected).toBe(false);
      expect(result.database.status).toBe('healthy');
    });

    it('never includes raw Redis INFO text, the redis host, or the redis port anywhere in the response', async () => {
      mockHealthyDatabase();

      const result = await service.getOverview();
      const serialized = JSON.stringify(result);

      expect(serialized).not.toMatch(/redis_version/);
      expect(serialized).not.toContain('used_memory_human');
      expect(serialized).not.toContain('localhost');
      expect(serialized).not.toContain('6379');
    });
  });

  describe('storage isolation', () => {
    it('degrades (never unhealthy-overall) when storage is not configured', async () => {
      mockHealthyDatabase();
      storage.checkBucketHealth.mockResolvedValue({
        configured: false,
        reachable: false,
        bucketAccessible: false,
      });

      const result = await service.getOverview();

      expect(result.storage.status).toBe('degraded');
      expect(result.status).toBe('degraded');
    });

    it('degrades when storage is configured and reachable but the bucket itself is not accessible', async () => {
      mockHealthyDatabase();
      storage.checkBucketHealth.mockResolvedValue({
        configured: true,
        reachable: true,
        bucketAccessible: false,
      });

      const result = await service.getOverview();

      expect(result.storage.status).toBe('degraded');
      expect(result.status).toBe('degraded');
    });

    it('never rejects getOverview even if the storage check itself throws', async () => {
      mockHealthyDatabase();
      storage.checkBucketHealth.mockRejectedValue(new Error('boom'));

      await expect(service.getOverview()).resolves.toBeDefined();
    });
  });

  describe('queue worker health', () => {
    it('is "available" (and queue status "healthy") when at least one worker is connected', async () => {
      mockHealthyDatabase();

      const result = await service.getOverview();

      const entry = result.queues.find((q) => q.name === 'scheduled-jobs')!;
      expect(entry.workerHealth).toBe('available');
      expect(entry.status).toBe('healthy');
    });

    it('is "unhealthy" when no worker is connected and jobs are waiting/delayed — but only degrades the OVERALL status, never escalates it to unhealthy', async () => {
      mockHealthyDatabase();
      (schedulerQueue.getWorkers as jest.Mock).mockResolvedValue([]);
      (schedulerQueue.getJobCounts as jest.Mock).mockResolvedValue({
        waiting: 3,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
      });

      const result = await service.getOverview();

      const entry = result.queues.find((q) => q.name === 'scheduled-jobs')!;
      expect(entry.workerHealth).toBe('unhealthy');
      expect(entry.status).toBe('unhealthy');
      // Queues are a soft dependency for this endpoint — see
      // MonitoringService.aggregateStatus's own doc comment.
      expect(result.status).toBe('degraded');
    });

    it('is "inactive" (queue status "degraded") when no worker is connected and the queue is empty — not necessarily an outage', async () => {
      mockHealthyDatabase();
      (notificationQueue.getWorkers as jest.Mock).mockResolvedValue([]);
      (notificationQueue.getJobCounts as jest.Mock).mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
      });

      const result = await service.getOverview();

      const entry = result.queues.find((q) => q.name === 'notification-dispatch')!;
      expect(entry.workerHealth).toBe('inactive');
      expect(entry.status).toBe('degraded');
      expect(result.status).toBe('degraded');
    });

    it('never rejects getOverview even if a queue check itself throws', async () => {
      mockHealthyDatabase();
      (schedulerQueue.getJobCounts as jest.Mock).mockRejectedValue(new Error('redis down'));

      const result = await service.getOverview();

      const entry = result.queues.find((q) => q.name === 'scheduled-jobs')!;
      expect(entry.status).toBe('unhealthy');
      expect(entry.workerHealth).toBe('unknown');
      expect(result.status).toBe('degraded');
    });
  });

  describe('scheduler last-run reporting', () => {
    it('reports lastSuccessfulRun/lastFailedRun from BullMQ job snapshots and never leaks failedReason', async () => {
      mockHealthyDatabase();
      const completedJob = { name: 'subscription-evaluate-expiry', finishedOn: 1735000000000 };
      const failedJob = {
        name: 'compliance-detect-anomalies',
        finishedOn: 1735000100000,
        failedReason: 'a raw db error message that must never appear in the response',
      };
      (schedulerQueue.getJobs as jest.Mock).mockImplementation((types: string[]) => {
        if (types[0] === 'completed') return Promise.resolve([completedJob]);
        if (types[0] === 'failed') return Promise.resolve([failedJob]);
        return Promise.resolve([]);
      });

      const result = await service.getOverview();

      expect(result.scheduler.lastSuccessfulRun).toEqual({
        jobName: 'subscription-evaluate-expiry',
        finishedAt: new Date(1735000000000).toISOString(),
      });
      expect(result.scheduler.lastFailedRun).toEqual({
        jobName: 'compliance-detect-anomalies',
        finishedAt: new Date(1735000100000).toISOString(),
      });
      expect(JSON.stringify(result.scheduler)).not.toContain('raw db error message');
    });

    it('reports scheduler status degraded (not unhealthy) when there is a nonzero failed count', async () => {
      mockHealthyDatabase();
      (schedulerQueue.getJobCounts as jest.Mock).mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 5,
        failed: 2,
        paused: 0,
      });

      const result = await service.getOverview();

      expect(result.scheduler.status).toBe('degraded');
      expect(result.status).toBe('degraded');
    });

    it('never rejects getOverview even if the scheduler check itself throws — and, being a soft dependency, only degrades the overall status', async () => {
      mockHealthyDatabase();
      (schedulerQueue.getJobs as jest.Mock).mockRejectedValue(new Error('boom'));

      const result = await service.getOverview();

      expect(result.scheduler.status).toBe('unhealthy');
      expect(result.status).toBe('degraded');
    });
  });
});
