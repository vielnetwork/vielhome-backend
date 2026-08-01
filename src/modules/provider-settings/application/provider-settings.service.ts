import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ProviderKey } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { EmailProviderService } from '../../../common/notification-providers/email-provider.service';
import { SmsProviderService } from '../../../common/notification-providers/sms-provider.service';
import { PushProviderService } from '../../../common/notification-providers/push-provider.service';

/** 21_ADRs > ADR-116 — the three provider keys this stage manages. See
 * `ProviderSetting`'s own schema comment for why `STORAGE` is
 * deliberately excluded in Phase 1. */
export const PROVIDER_KEYS: ProviderKey[] = ['EMAIL', 'SMS', 'PUSH'];

export interface ProviderSettingStatus {
  key: ProviderKey;
  enabled: boolean;
  /** Env-var presence only (`isConfigured()`), reused unchanged from each
   * provider's own service — never a secret value. See this codebase's
   * "never expose credentials/internal details" principle. */
  configured: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedById: string | null;
}

/**
 * 21_ADRs > ADR-116 — Global Provider Settings (Backoffice completion
 * roadmap, Stage 9). Backs `ProviderSetting`, one row per `ProviderKey`
 * (see that model's own schema comment for the full rationale — this
 * table never stores a credential, only a DB-backed enable/disable
 * switch, reason, and audit metadata per provider).
 *
 * `isEnabled(key)` is a synchronous, in-memory read of a cached map —
 * the same hot-path discipline `MaintenanceModeService.isEnabled()`
 * already established: `NotificationDispatchProcessor` consults this on
 * every single dispatch attempt for Email/SMS/Push, and a database
 * round-trip there would be real, avoidable latency added to the
 * platform's busiest queue consumer. The cache is loaded at boot
 * (`onModuleInit`) and refreshed immediately after every successful
 * `setEnabled` call — no polling, no cross-instance invalidation (see
 * `MaintenanceModeService`'s own doc comment for the identical,
 * documented single-process limitation).
 *
 * The safe default — before this service has ever loaded real state, if
 * loading fails, or for a key with no row yet — is always `enabled:
 * true`: this service must never cause the platform to silently stop
 * sending real SMS/Email/Push because of a transient read failure or a
 * not-yet-created row. This is the mirror image of `MaintenanceModeService`'s
 * own safe default (`false`) — there, the safe state is "not in
 * maintenance"; here, the safe state is "provider left on," since these
 * rows model an opt-in DISABLE, not an opt-in enable.
 */
@Injectable()
export class ProviderSettingsService implements OnModuleInit {
  private readonly logger = new Logger(ProviderSettingsService.name);
  private readonly cachedEnabled = new Map<ProviderKey, boolean>(
    PROVIDER_KEYS.map((key) => [key, true]),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emailProvider: EmailProviderService,
    private readonly smsProvider: SmsProviderService,
    private readonly pushProvider: PushProviderService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.providerSetting.findMany();
      for (const row of rows) {
        this.cachedEnabled.set(row.key, row.enabled);
      }
    } catch (err) {
      this.logger.error(
        'Failed to load provider settings at boot — defaulting every provider to enabled.',
        (err as Error)?.stack,
      );
    }
  }

  /** Cheap, synchronous, in-memory read — see this class's own doc comment. */
  isEnabled(key: ProviderKey): boolean {
    return this.cachedEnabled.get(key) ?? true;
  }

  async list(): Promise<ProviderSettingStatus[]> {
    const rows = await this.prisma.providerSetting.findMany();
    const rowByKey = new Map(rows.map((row) => [row.key, row]));

    return PROVIDER_KEYS.map((key) => {
      const row = rowByKey.get(key);
      return {
        key,
        enabled: row?.enabled ?? true,
        configured: this.isConfiguredFor(key),
        reason: row?.reason ?? null,
        updatedAt: row?.updatedAt?.toISOString() ?? null,
        updatedById: row?.updatedById ?? null,
      };
    });
  }

  /**
   * Idempotent, same discipline as `MaintenanceModeService.setEnabled` —
   * re-applying the same `enabled` value is a safe no-op with respect to
   * dispatch behavior, but is still written and audited: a reaffirmed
   * "still disabled, still for this reason" is real operational history,
   * not noise to suppress.
   */
  async setEnabled(
    key: ProviderKey,
    input: { enabled: boolean; reason: string },
    actorId: string,
    requestId: string,
  ): Promise<ProviderSettingStatus> {
    if (!PROVIDER_KEYS.includes(key)) {
      throw new NotFoundAppError('Unknown provider key.');
    }

    const existing = await this.prisma.providerSetting.findUnique({ where: { key } });
    const before = existing?.enabled ?? true;

    const row = await this.prisma.providerSetting.upsert({
      where: { key },
      create: { key, enabled: input.enabled, reason: input.reason, updatedById: actorId },
      update: { enabled: input.enabled, reason: input.reason, updatedById: actorId },
    });

    this.cachedEnabled.set(key, row.enabled);

    await this.audit.record({
      actorId,
      action: input.enabled ? 'ProviderEnabledByAdmin' : 'ProviderDisabledByAdmin',
      entityType: 'ProviderSetting',
      entityId: key,
      reason: input.reason,
      requestId,
      metadata: { before: { enabled: before }, after: { enabled: input.enabled } },
    });

    return {
      key,
      enabled: row.enabled,
      configured: this.isConfiguredFor(key),
      reason: row.reason,
      updatedAt: row.updatedAt.toISOString(),
      updatedById: row.updatedById,
    };
  }

  private isConfiguredFor(key: ProviderKey): boolean {
    if (key === 'EMAIL') return this.emailProvider.isConfigured();
    if (key === 'SMS') return this.smsProvider.isConfigured();
    return this.pushProvider.isConfigured();
  }
}
