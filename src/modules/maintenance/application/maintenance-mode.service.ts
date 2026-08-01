import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';

/**
 * 21_ADRs > ADR-109 — Maintenance Mode. Backs `MaintenanceModeState`, a
 * deliberate single-row table (see that model's own schema comment):
 * every read/write here targets the one row whose `id` is this fixed
 * literal.
 */
export const MAINTENANCE_MODE_SINGLETON_ID = 'singleton';

export interface MaintenanceModeStatus {
  enabled: boolean;
  reason: string | null;
  message: string | null;
  updatedAt: string;
  updatedById: string | null;
}

interface MaintenanceModeRow {
  enabled: boolean;
  reason: string | null;
  message: string | null;
  updatedAt: Date;
  updatedById: string | null;
}

/**
 * Global, platform-wide maintenance-mode state. The safe default (before
 * this service has ever loaded real state, or if loading it fails) is
 * always `enabled: false` — this service must never cause the platform to
 * silently enter maintenance mode by accident.
 *
 * `isEnabled()` is a synchronous, in-memory read of a cached value — this
 * is deliberate: `MaintenanceModeMiddleware` calls it on every single
 * incoming HTTP request, and a database round-trip on every request
 * (including every request while maintenance mode is OFF, the overwhelming
 * common case) would be real, avoidable latency added to the entire
 * platform's hot path. The cache is refreshed at boot (`onModuleInit`) and
 * immediately after every successful `setEnabled` call — there is no
 * polling and no cross-instance invalidation; a multi-instance deployment
 * would need a shared invalidation mechanism (Redis pub/sub, or a short
 * TTL re-poll) to stay consistent across processes, which is out of scope
 * for this ADR (see ADR-109 Future Review) — this codebase currently runs
 * as a single Node process.
 */
@Injectable()
export class MaintenanceModeService implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceModeService.name);
  private cached: MaintenanceModeStatus = {
    enabled: false,
    reason: null,
    message: null,
    updatedAt: new Date(0).toISOString(),
    updatedById: null,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const row = await this.prisma.maintenanceModeState.findUnique({
        where: { id: MAINTENANCE_MODE_SINGLETON_ID },
      });
      if (row) {
        this.cached = this.toStatus(row);
      }
    } catch (err) {
      // Safe default: if the row can't be read at boot (e.g. this
      // migration hasn't been applied yet in some environment), the
      // platform stays OPEN — it never silently starts in maintenance
      // mode because of a transient or missing-schema read failure.
      this.logger.error(
        'Failed to load maintenance mode state at boot — defaulting to disabled.',
        (err as Error)?.stack,
      );
    }
  }

  /** Cheap, synchronous, in-memory read — see this class's own doc comment. */
  isEnabled(): boolean {
    return this.cached.enabled;
  }

  getStatus(): MaintenanceModeStatus {
    return this.cached;
  }

  /**
   * Enabling and disabling both go through this one method — there is no
   * separate "emergency disable" path, because none is needed: the
   * maintenance-mode endpoints themselves are always on
   * `MaintenanceModeMiddleware`'s exemption allowlist (admin-lockout
   * prevention lives there, not here — see that middleware's own doc
   * comment), so any staff member holding `MAINTENANCE_MODE_MANAGE` can
   * always reach this call, even while maintenance mode is currently
   * enabled.
   *
   * Idempotent: calling this with the same `enabled` value the state
   * already has is a safe no-op with respect to platform behavior, but
   * it is still written and audited as a genuine action (a reaffirmed
   * "still in maintenance, still for this reason" is meaningful
   * operational history, not noise to be suppressed).
   */
  async setEnabled(
    input: { enabled: boolean; reason: string; message?: string },
    actorId: string,
    requestId: string,
  ): Promise<MaintenanceModeStatus> {
    const before = this.cached;

    const row = await this.prisma.maintenanceModeState.upsert({
      where: { id: MAINTENANCE_MODE_SINGLETON_ID },
      create: {
        id: MAINTENANCE_MODE_SINGLETON_ID,
        enabled: input.enabled,
        reason: input.reason,
        message: input.message ?? null,
        updatedById: actorId,
      },
      update: {
        enabled: input.enabled,
        reason: input.reason,
        message: input.message ?? null,
        updatedById: actorId,
      },
    });

    this.cached = this.toStatus(row);

    await this.audit.record({
      actorId,
      action: input.enabled ? 'MaintenanceModeEnabled' : 'MaintenanceModeDisabled',
      entityType: 'MaintenanceModeState',
      entityId: MAINTENANCE_MODE_SINGLETON_ID,
      reason: input.reason,
      requestId,
      metadata: {
        before: { enabled: before.enabled },
        after: { enabled: input.enabled },
        message: input.message ?? null,
      },
    });

    return this.cached;
  }

  private toStatus(row: MaintenanceModeRow): MaintenanceModeStatus {
    return {
      enabled: row.enabled,
      reason: row.reason,
      message: row.message,
      updatedAt: row.updatedAt.toISOString(),
      updatedById: row.updatedById,
    };
  }
}
