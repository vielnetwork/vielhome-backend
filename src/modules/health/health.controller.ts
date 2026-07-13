import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppConfig } from '../../config/configuration';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // 21_ADRs > ADR-061 — infra health-check probes (load balancer / uptime
  // monitor) poll frequently and must never be rejected by the newly-
  // enforced global ThrottlerGuard. Applies to every route in this
  // controller, not just this one.
  @SkipThrottle()
  @Get()
  async check() {
    // Unchanged since before ADR-064 — kept for backward compatibility
    // with any existing consumer already polling this exact path/shape.
    // New consumers should prefer /health/live or /health/ready below.
    return {
      status: (await this.checkDatabase()) === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      database: await this.checkDatabase(),
    };
  }

  // 21_ADRs > ADR-064 — 24_Release_Readiness_Audit_v1.0 > 3.2 named "no
  // separate readiness/liveness split" as a gap. Liveness answers "is this
  // process alive at all" with zero dependency checks — an orchestrator
  // uses this to decide whether to RESTART the container. A slow/
  // unreachable database should never trigger a restart (restarting the
  // app won't fix a database outage) — only readiness should react to
  // that, which is exactly why liveness and readiness are different
  // endpoints, not one endpoint with two names.
  @SkipThrottle()
  @Get('live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  // Readiness: "should traffic be routed to this instance right now" —
  // checks both hard dependencies this app cannot function without
  // (closes the other half of the audit's 3.2 gap: "no Redis/queue health
  // check"). Deliberately still returns HTTP 200 with a `degraded` body
  // value even when a dependency is down, matching this controller's
  // pre-existing convention (the original `check()` above never set a
  // non-2xx status either) rather than introducing a second convention —
  // a real orchestrator deployment (none exists yet per the audit's own
  // findings) may want a non-2xx on degraded; flagged as a future
  // refinement, not built here.
  @SkipThrottle()
  @Get('ready')
  async ready() {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      database,
      redis,
    };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  // No shared, injectable Redis client exists anywhere in this codebase
  // yet (QueueConfigModule/ADR-054 only holds BullMQ's own internal
  // connection, not one exposed via DI) — `ioredis` is already a direct
  // dependency (not transitive), so a short-lived, dedicated connection
  // per readiness check is the lowest-risk option here. A shared
  // injectable client would avoid the per-call connection overhead;
  // flagged as a future refinement given readiness checks are expected to
  // be low-frequency (an orchestrator polling every few seconds, not
  // per-request), not a current problem.
  private async checkRedis(): Promise<'up' | 'down'> {
    const client = new Redis({
      host: this.config.get('redis.host', { infer: true }),
      port: this.config.get('redis.port', { infer: true }),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });
    // ioredis's EventEmitter contract throws on an unhandled 'error' event
    // — an unreachable Redis must fail this check gracefully, not crash
    // the process that's asking whether Redis is reachable.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
      return 'up';
    } catch {
      return 'down';
    } finally {
      client.disconnect();
    }
  }
}
