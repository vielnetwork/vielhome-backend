import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StorageService } from '../../../common/storage/storage.service';
import type { AppConfig } from '../../../config/configuration';
import { SCHEDULED_JOBS_QUEUE } from '../../scheduler/application/scheduled-jobs.processor';
import { NOTIFICATION_DISPATCH_QUEUE } from '../../notifications/application/notification-dispatch.processor';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DatabaseSection {
  status: HealthStatus;
  connected: boolean;
  latencyMs: number | null;
  databaseConnections:
    | {
        metricsAvailable: true;
        active: number;
        idle: number;
        idleInTransaction: number;
        total: number;
      }
    | { metricsAvailable: false };
}

export interface RedisSection {
  status: HealthStatus;
  connected: boolean;
  latencyMs: number | null;
  metricsAvailable: boolean;
  uptimeSeconds?: number;
  usedMemoryBytes?: number;
  connectedClients?: number;
  role?: string;
  keyCount?: number;
}

export interface StorageSection {
  status: HealthStatus;
  configured: boolean;
  reachable: boolean;
  bucketAccessible: boolean;
}

/**
 * `available` — at least one BullMQ worker is currently connected to this
 * queue. `unhealthy` — no worker is connected AND there is pending work
 * (waiting/delayed jobs) nobody is processing. `inactive` — no worker is
 * connected but the queue is also empty, which in a small/dev deployment
 * can be entirely normal (no work to do right now) rather than a real
 * outage. `unknown` — the worker/queue lookup itself failed, so no
 * inference can be made either way. A worker's presence here is Redis
 * bookkeeping only (BullMQ's `CLIENT LIST` on the queue's connection) —
 * it is NOT a guarantee the worker process is alive and not hung; a
 * dedicated heartbeat is explicitly out of scope for this phase (see
 * ADR-108's own Future Review).
 */
export type WorkerHealth = 'available' | 'unhealthy' | 'inactive' | 'unknown';

export interface QueueSection {
  name: string;
  status: HealthStatus;
  /** `completedSnapshot`/`failedSnapshot` are BullMQ's current in-memory/Redis snapshot only, not permanent history — old entries are pruned per this codebase's job-options `removeOnComplete`/`removeOnFail` settings. */
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completedSnapshot: number;
    failedSnapshot: number;
    pausedSnapshot: number;
  };
  isPaused: boolean;
  workerCount: number;
  workerHealth: WorkerHealth;
}

export interface SchedulerSection {
  status: HealthStatus;
  lastSuccessfulRun: { jobName: string; finishedAt: string } | null;
  lastFailedRun: { jobName: string; finishedAt: string } | null;
  counts: { waiting: number; delayed: number; failed: number };
}

export interface MonitoringOverview {
  status: HealthStatus;
  checkedAt: string;
  database: DatabaseSection;
  redis: RedisSection;
  storage: StorageSection;
  queues: QueueSection[];
  scheduler: SchedulerSection;
}

/** Extracts one `field:value` line out of a targeted `INFO <section>` reply — never the whole reply. */
function parseIntInfoField(info: string, field: string): number | null {
  const match = info.match(new RegExp(`^${field}:(\\d+)`, 'm'));
  return match ? parseInt(match[1], 10) : null;
}

function parseStringInfoField(info: string, field: string): string | null {
  const match = info.match(new RegExp(`^${field}:(\\S+)`, 'm'));
  return match ? match[1] : null;
}

/**
 * 21_ADRs > ADR-108 — Backoffice Monitoring & System Health. Backs
 * `GET /api/v1/backoffice/monitoring/overview`, the first staff-only
 * operational-telemetry endpoint in this codebase (distinct from
 * `HealthController`'s unauthenticated infra probes, which this module
 * does not touch).
 *
 * Every dependency check below is independent, has its own timeout, and
 * NEVER throws out of its own method — each swallows its own failure and
 * returns an `unhealthy`/`unavailable` shaped result instead. `getOverview`
 * additionally wraps every call in `Promise.allSettled` as defense in
 * depth, per this ADR's explicit requirement that one dependency's outage
 * must never reject the whole endpoint or produce a 500. A 500 here is
 * reserved for a failure in this aggregation pipeline itself, not in any
 * one checked dependency.
 *
 * Deliberately reports operational health only — no query text, PIDs,
 * client addresses, raw Redis `INFO` output, connection strings,
 * hostnames, access keys, or raw provider errors are ever included in the
 * response. See each private `check*` method's own doc comment for what
 * it does and does not expose.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  private static readonly DB_TIMEOUT_MS = 2000;
  private static readonly REDIS_TIMEOUT_MS = 2000;
  private static readonly STORAGE_TIMEOUT_MS = 3000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly storage: StorageService,
    @InjectQueue(SCHEDULED_JOBS_QUEUE) private readonly schedulerQueue: Queue,
    @InjectQueue(NOTIFICATION_DISPATCH_QUEUE) private readonly notificationQueue: Queue,
  ) {}

  async getOverview(): Promise<MonitoringOverview> {
    const [
      databaseResult,
      redisResult,
      storageResult,
      schedulerQueueResult,
      notificationQueueResult,
      schedulerResult,
    ] = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStorage(),
      this.checkQueue(this.schedulerQueue, 'scheduled-jobs'),
      this.checkQueue(this.notificationQueue, 'notification-dispatch'),
      this.checkScheduler(),
    ]);

    const database = this.unwrap(databaseResult, this.unhealthyDatabase());
    const redis = this.unwrap(redisResult, this.unhealthyRedis());
    const storage = this.unwrap(storageResult, this.unhealthyStorage());
    const schedulerQueue = this.unwrap(schedulerQueueResult, this.unhealthyQueue('scheduled-jobs'));
    const notificationQueue = this.unwrap(
      notificationQueueResult,
      this.unhealthyQueue('notification-dispatch'),
    );
    const scheduler = this.unwrap(schedulerResult, this.unhealthyScheduler());

    const queues = [schedulerQueue, notificationQueue];

    return {
      status: this.aggregateStatus({ database, redis, storage, queues, scheduler }),
      checkedAt: new Date().toISOString(),
      database,
      redis,
      storage,
      queues,
      scheduler,
    };
  }

  private unwrap<T>(result: PromiseSettledResult<T>, fallback: T): T {
    if (result.status === 'fulfilled') return result.value;
    this.logger.warn(
      `A monitoring sub-check rejected unexpectedly: ${result.reason?.name ?? 'unknown error'}`,
    );
    return fallback;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Connectivity via the exact `SELECT 1` probe `HealthController` already
   * uses, plus a `pg_stat_activity` activity summary scoped to only the
   * current database and current connecting user (never another
   * database/role's connections). Deliberately named `databaseConnections`
   * — NOT `prismaPool` — since this reads real Postgres server-side state,
   * not Prisma's own (unused, `previewFeatures` not enabled) Metrics
   * Preview. Never returns query text, PID, or client address — only
   * per-state counts. If the activity query itself fails (e.g. a
   * restricted role without `pg_monitor`), connectivity is still reported
   * from the `SELECT 1` result alone, with `metricsAvailable: false`.
   */
  private async checkDatabase(): Promise<DatabaseSection> {
    const start = Date.now();
    try {
      await this.withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        MonitoringService.DB_TIMEOUT_MS,
        'database connectivity check',
      );
      const latencyMs = Date.now() - start;
      const databaseConnections = await this.tryGetPostgresActivity();
      return { status: 'healthy', connected: true, latencyMs, databaseConnections };
    } catch {
      return this.unhealthyDatabase();
    }
  }

  private async tryGetPostgresActivity(): Promise<DatabaseSection['databaseConnections']> {
    try {
      const rows = await this.withTimeout(
        this.prisma.$queryRaw<
          Array<{ active: bigint; idle: bigint; idle_in_transaction: bigint; total: bigint }>
        >`
          SELECT
            count(*) FILTER (WHERE state = 'active') AS active,
            count(*) FILTER (WHERE state = 'idle') AS idle,
            count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction,
            count(*) AS total
          FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user
        `,
        MonitoringService.DB_TIMEOUT_MS,
        'postgres activity check',
      );
      const row = rows[0];
      if (!row) return { metricsAvailable: false };
      return {
        metricsAvailable: true,
        active: Number(row.active),
        idle: Number(row.idle),
        idleInTransaction: Number(row.idle_in_transaction),
        total: Number(row.total),
      };
    } catch {
      // Connectivity above already succeeded — an activity-query failure
      // (e.g. a role without pg_stat_activity visibility on a managed
      // Postgres) only downgrades the activity summary, never the
      // connectivity verdict (ADR-108's explicit requirement).
      return { metricsAvailable: false };
    }
  }

  /**
   * Connectivity via `PING` on a short-lived client (same disposable-
   * connection pattern `HealthController.checkRedis` already uses), then
   * a limited, explicitly-fielded summary read from targeted `INFO
   * <section>` calls (`server`/`memory`/`clients`/`replication`) — never
   * the full `INFO` reply, and never `KEYS`/`SCAN` (key count comes from
   * `DBSIZE`, an O(1) command). No URL, password, hostname, or other
   * config is ever read from these replies.
   */
  private async checkRedis(): Promise<RedisSection> {
    const start = Date.now();
    const client = new Redis({
      host: this.config.get('redis.host', { infer: true }),
      port: this.config.get('redis.port', { infer: true }),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: MonitoringService.REDIS_TIMEOUT_MS,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
      const latencyMs = Date.now() - start;
      const summary = await this.tryGetRedisSummary(client);
      return {
        status: 'healthy',
        connected: true,
        latencyMs,
        metricsAvailable: summary !== null,
        ...(summary ?? {}),
      };
    } catch {
      return this.unhealthyRedis();
    } finally {
      client.disconnect();
    }
  }

  private async tryGetRedisSummary(client: Redis): Promise<{
    uptimeSeconds: number;
    usedMemoryBytes: number;
    connectedClients: number;
    role: string;
    keyCount: number;
  } | null> {
    try {
      const [serverInfo, memoryInfo, clientsInfo, replicationInfo, keyCount] = await Promise.all([
        client.info('server'),
        client.info('memory'),
        client.info('clients'),
        client.info('replication'),
        client.dbsize(),
      ]);
      const uptimeSeconds = parseIntInfoField(serverInfo, 'uptime_in_seconds');
      const usedMemoryBytes = parseIntInfoField(memoryInfo, 'used_memory');
      const connectedClients = parseIntInfoField(clientsInfo, 'connected_clients');
      const role = parseStringInfoField(replicationInfo, 'role');
      if (
        uptimeSeconds === null ||
        usedMemoryBytes === null ||
        connectedClients === null ||
        role === null
      ) {
        return null;
      }
      return { uptimeSeconds, usedMemoryBytes, connectedClients, role, keyCount };
    } catch {
      return null;
    }
  }

  /** Delegates to `StorageService.checkBucketHealth` — see that method's own doc comment for the exact `configured`/`reachable`/`bucketAccessible` semantics. */
  private async checkStorage(): Promise<StorageSection> {
    try {
      const result = await this.storage.checkBucketHealth(MonitoringService.STORAGE_TIMEOUT_MS);
      const status: HealthStatus = !result.configured
        ? 'degraded'
        : result.bucketAccessible
          ? 'healthy'
          : result.reachable
            ? 'degraded'
            : 'unhealthy';
      return { status, ...result };
    } catch {
      return this.unhealthyStorage();
    }
  }

  /**
   * `Queue.getJobCounts` + `Queue.getWorkers` — both already-existing
   * BullMQ APIs, no new infrastructure. See `WorkerHealth`'s own doc
   * comment for the exact available/unhealthy/inactive/unknown semantics.
   */
  private async checkQueue(queue: Queue, name: string): Promise<QueueSection> {
    try {
      const [counts, isPaused, workers] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
        queue.isPaused(),
        queue.getWorkers(),
      ]);
      const waiting = counts.waiting ?? 0;
      const delayed = counts.delayed ?? 0;
      const workerCount = workers.length;
      const hasPendingWork = waiting > 0 || delayed > 0;
      const workerHealth: WorkerHealth =
        workerCount > 0 ? 'available' : hasPendingWork ? 'unhealthy' : 'inactive';
      const status: HealthStatus =
        workerHealth === 'available'
          ? 'healthy'
          : workerHealth === 'unhealthy'
            ? 'unhealthy'
            : 'degraded';

      return {
        name,
        status,
        counts: {
          waiting,
          active: counts.active ?? 0,
          delayed,
          completedSnapshot: counts.completed ?? 0,
          failedSnapshot: counts.failed ?? 0,
          pausedSnapshot: counts.paused ?? 0,
        },
        isPaused,
        workerCount,
        workerHealth,
      };
    } catch {
      return this.unhealthyQueue(name);
    }
  }

  /**
   * Best-effort operational snapshot for the `scheduled-jobs` queue
   * specifically (the other queue, `notification-dispatch`, is only
   * reported in `queues[]` above — this section is scheduler-specific).
   * `lastSuccessfulRun`/`lastFailedRun` come from BullMQ's own current
   * completed/failed job lists (`Queue.getJobs`), most-recent first — NOT
   * a permanent audit trail, and pruned by this codebase's existing
   * `removeOnComplete`/`removeOnFail` job options. `failedReason` is
   * deliberately never read — only the failed job's name and timestamp.
   */
  private async checkScheduler(): Promise<SchedulerSection> {
    try {
      const [counts, completedJobs, failedJobs] = await Promise.all([
        this.schedulerQueue.getJobCounts('waiting', 'delayed', 'failed'),
        this.schedulerQueue.getJobs(['completed'], 0, 0, false),
        this.schedulerQueue.getJobs(['failed'], 0, 0, false),
      ]);

      const lastCompleted = completedJobs[0];
      const lastFailed = failedJobs[0];

      const lastSuccessfulRun = lastCompleted
        ? {
            jobName: lastCompleted.name,
            finishedAt: new Date(lastCompleted.finishedOn ?? Date.now()).toISOString(),
          }
        : null;
      const lastFailedRun = lastFailed
        ? {
            jobName: lastFailed.name,
            finishedAt: new Date(lastFailed.finishedOn ?? Date.now()).toISOString(),
          }
        : null;

      const failed = counts.failed ?? 0;
      const status: HealthStatus = failed > 0 ? 'degraded' : 'healthy';

      return {
        status,
        lastSuccessfulRun,
        lastFailedRun,
        counts: { waiting: counts.waiting ?? 0, delayed: counts.delayed ?? 0, failed },
      };
    } catch {
      return this.unhealthyScheduler();
    }
  }

  /**
   * Database and Redis are hard dependencies (mirrors `/health/ready`'s
   * own database+redis pairing) — either being `unhealthy` makes the
   * whole snapshot `unhealthy`. Storage, each queue, and the scheduler
   * snapshot are soft dependencies for this endpoint's purposes: a
   * stalled worker or an unreachable object store is a real operational
   * problem, but never escalates the overall snapshot past `degraded`.
   */
  private aggregateStatus(sections: {
    database: DatabaseSection;
    redis: RedisSection;
    storage: StorageSection;
    queues: QueueSection[];
    scheduler: SchedulerSection;
  }): HealthStatus {
    if (sections.database.status === 'unhealthy' || sections.redis.status === 'unhealthy') {
      return 'unhealthy';
    }

    const softSections: Array<{ status: HealthStatus }> = [
      sections.storage,
      sections.scheduler,
      ...sections.queues,
    ];
    const anyNotHealthy =
      sections.database.status === 'degraded' ||
      sections.redis.status === 'degraded' ||
      softSections.some((s) => s.status !== 'healthy');

    return anyNotHealthy ? 'degraded' : 'healthy';
  }

  private unhealthyDatabase(): DatabaseSection {
    return {
      status: 'unhealthy',
      connected: false,
      latencyMs: null,
      databaseConnections: { metricsAvailable: false },
    };
  }

  private unhealthyRedis(): RedisSection {
    return { status: 'unhealthy', connected: false, latencyMs: null, metricsAvailable: false };
  }

  private unhealthyStorage(): StorageSection {
    return { status: 'unhealthy', configured: false, reachable: false, bucketAccessible: false };
  }

  private unhealthyQueue(name: string): QueueSection {
    return {
      name,
      status: 'unhealthy',
      counts: {
        waiting: 0,
        active: 0,
        delayed: 0,
        completedSnapshot: 0,
        failedSnapshot: 0,
        pausedSnapshot: 0,
      },
      isPaused: false,
      workerCount: 0,
      workerHealth: 'unknown',
    };
  }

  private unhealthyScheduler(): SchedulerSection {
    return {
      status: 'unhealthy',
      lastSuccessfulRun: null,
      lastFailedRun: null,
      counts: { waiting: 0, delayed: 0, failed: 0 },
    };
  }
}
