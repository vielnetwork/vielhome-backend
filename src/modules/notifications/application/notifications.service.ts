import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  Prisma,
} from '@prisma/client';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { NotificationPolicy } from '../domain/policies/notification.policy';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import { UpdatePushTokenDto } from './dto/update-push-token.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import {
  DISPATCH_DELIVERY_JOB,
  NOTIFICATION_DISPATCH_QUEUE,
} from './notification-dispatch.processor';

const ALL_CHANNELS: NotificationChannel[] = ['IN_APP', 'PUSH', 'EMAIL', 'SMS'];

export interface NotifyInput {
  recipientId: string;
  buildingId?: string;
  category: NotificationCategory;
  priority?: NotificationPriority;
  title: string;
  body: string;
  referenceType?: string;
  referenceId?: string;
  sourceEvent?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly policy: NotificationPolicy,
    private readonly audit: AuditService,
    @InjectQueue(NOTIFICATION_DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
  ) {}

  /**
   * The single entry point every domain event listener calls
   * (`NotificationEventListener`). Resolves per-channel delivery against
   * the recipient's preference + this notification's priority, creates
   * the Notification + NotificationDelivery rows, and dispatches every
   * channel. IN_APP is real and instant (readable via the in-app center
   * the moment it's created, no external dependency) so it's still marked
   * SENT synchronously, unchanged since ADR-027. Every non-IN_APP channel
   * (PUSH/EMAIL/SMS) now dispatches asynchronously via a real BullMQ queue
   * (21_ADRs > ADR-039) instead of a synchronous log-stub inline in this
   * request — `NotificationDispatchProcessor` picks the job up in a
   * background worker and does the actual (still-stubbed, no real
   * provider yet) dispatch there. If every channel is gated off, nothing
   * is created at all — an opted-out recipient generates no notification
   * history, which is the intended effect of disabling every channel.
   *
   * 21_ADRs > ADR-079 round-1 fix — a real toolchain run (9 e2e suites
   * running concurrently for the first time) surfaced a genuine, if
   * narrow, race here too: `AchievementUnlocked`'s `EventEmitter2.emit()`
   * is fire-and-forget, so this whole method can still be mid-flight for
   * a `recipientId` whose Person row a *different*, concurrent test
   * describe's own cleanup batch has just deleted — the same standing
   * "test cleanup races an un-awaited event chain" bug class
   * `ADR-070`/`ADR-074`/`ADR-077`/`ADR-079` (Gamification's own
   * `applyBuildingScoreDelta`, see that method's doc comment) have each
   * already found and fixed in their own domain. `getOrCreatePreference`
   * already handled the narrower P2002 concurrent-create race (`ADR-070`);
   * a fully-deleted recipient surfaces differently and less predictably —
   * Prisma's own upsert implementation can throw `PrismaClientUnknownRequestError`
   * or `PrismaClientKnownRequestError` with varying messages/codes
   * depending on exactly which internal step raced the deletion — so this
   * method now wraps its own body and treats any of those shapes as "the
   * recipient no longer exists, nothing meaningful to notify," logging and
   * returning instead of letting a raw internal Prisma error bubble up to
   * the event-listener wrapper. Since no product feature ever hard-deletes
   * a Person, this branch is unreachable in production today — but it is
   * the semantically correct behavior regardless of cause, not merely a
   * test-only patch.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const priority = input.priority ?? 'NORMAL';
      const preference = await this.notifications.getOrCreatePreference(input.recipientId);

      const channels = ALL_CHANNELS.filter((channel) =>
        this.policy.isChannelEnabled(channel, priority, preference),
      );
      if (channels.length === 0) return;

      const created = await this.notifications.createNotification({
        recipientId: input.recipientId,
        buildingId: input.buildingId,
        category: input.category,
        priority,
        title: input.title,
        body: input.body,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        sourceEvent: input.sourceEvent,
        channels,
      });

      await this.audit.record({
        buildingId: input.buildingId,
        action: 'NotificationCreated',
        entityType: 'Notification',
        entityId: created.id,
        metadata: { category: input.category, sourceEvent: input.sourceEvent, channels },
      });

      for (const delivery of created.deliveries) {
        if (delivery.channel === 'IN_APP') {
          await this.notifications.markDeliverySent(delivery.id);
          continue;
        }
        // `jobId: delivery.id` gives idempotent enqueueing — the same
        // pattern ADR-036 used fixed jobIds for, just for a different
        // reason there (safe re-registration across restarts) than here
        // (never double-queue the same delivery row). `attempts`/`backoff`
        // are forward-looking: the current stub dispatch can never actually
        // throw, but a real provider (Future Review) will be able to, and
        // `NotificationDispatchProcessor.onFailed` is already wired to
        // record a permanent failure once retries are exhausted.
        await this.dispatchQueue.add(
          DISPATCH_DELIVERY_JOB,
          { deliveryId: delivery.id },
          { jobId: delivery.id, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
        );
      }
    } catch (error) {
      if (this.isMissingRecipientError(error)) {
        this.logger.warn(
          `notify(): recipient ${input.recipientId} no longer exists (likely a concurrent ` +
            'test-cleanup deletion racing this in-flight event, sourceEvent=' +
            `${input.sourceEvent ?? 'unknown'}) — skipping this notification.`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * True for the family of Prisma errors a concurrently-deleted recipient
   * Person can produce mid-`notify()` — checked by error class/code first,
   * then by message-content matching regardless of class (see this
   * method's caller's own doc comment for the full story).
   *
   * 21_ADRs > ADR-080 round-1 fix — a real toolchain run (a 10th e2e suite,
   * `manager-verification.e2e-spec.ts`, joining the pack for the first
   * time) surfaced a THIRD distinct shape of this same standing race: this
   * time Prisma's own query engine classified the identical "Expected a
   * valid parent ID to be present for create follow-up for upsert query"
   * assertion as a `PrismaClientKnownRequestError` with a code other than
   * `P2003`/`P2025` (unlike `ADR-079` round-1's own occurrence, which saw
   * it thrown as `PrismaClientUnknownRequestError`) — meaning the
   * class-then-code check below fell through to `false` and let a real,
   * still-benign error re-throw and log. Prisma's own error
   * classification for this particular internal-upsert assertion is
   * evidently not stable across runs/engine versions, so message-content
   * matching now applies to EVERY Prisma error class this method sees,
   * not just the two classes that lack a stable code — the class/code
   * check stays first purely as a fast path for the common, well-defined
   * P2003/P2025 cases.
   */
  private isMissingRecipientError(error: unknown): boolean {
    const isPrismaError =
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientValidationError;
    if (!isPrismaError) return false;

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2003' || error.code === 'P2025')
    ) {
      return true;
    }

    const message = error.message ?? '';
    return (
      message.includes('found no record') ||
      message.includes('parent ID to be present') ||
      message.includes('Record to update not found') ||
      message.includes('required but not found')
    );
  }

  /** Fan-out helper for building-wide/role-broadcast recipients — each recipient gets their own independent preference check. */
  async notifyMany(recipientIds: string[], input: Omit<NotifyInput, 'recipientId'>): Promise<void> {
    await Promise.all(recipientIds.map((recipientId) => this.notify({ ...input, recipientId })));
  }

  async listNotifications(
    personId: string,
    filter?: { category?: NotificationCategory; unreadOnly?: boolean; includeArchived?: boolean },
  ) {
    return this.notifications.listForPerson(personId, filter);
  }

  async searchNotifications(
    personId: string,
    params: { title?: string; category?: NotificationCategory },
  ) {
    return this.notifications.searchForPerson(personId, params);
  }

  async getUnreadCount(personId: string) {
    return { count: await this.notifications.countUnread(personId) };
  }

  private async getNotificationOrThrow(id: string, personId: string) {
    const found = await this.notifications.findById(id);
    if (!found) throw new NotFoundAppError('Notification not found.');
    this.policy.assertRecipient(found.recipientId, personId);
    return found;
  }

  async getNotification(id: string, personId: string) {
    return this.getNotificationOrThrow(id, personId);
  }

  async markAsRead(id: string, personId: string, requestId: string) {
    await this.getNotificationOrThrow(id, personId);
    const updated = await this.notifications.markRead(id);
    await this.audit.record({
      actorId: personId,
      action: 'NotificationRead',
      entityType: 'Notification',
      entityId: id,
      requestId,
    });
    return updated;
  }

  async markAllAsRead(personId: string, requestId: string) {
    const result = await this.notifications.markAllRead(personId);
    await this.audit.record({
      actorId: personId,
      action: 'NotificationRead',
      entityType: 'Notification',
      entityId: 'ALL',
      requestId,
      metadata: { count: result.count },
    });
    return result;
  }

  async archiveNotification(id: string, personId: string, requestId: string) {
    await this.getNotificationOrThrow(id, personId);
    const updated = await this.notifications.archive(id);
    await this.audit.record({
      actorId: personId,
      action: 'NotificationArchived',
      entityType: 'Notification',
      entityId: id,
      requestId,
    });
    return updated;
  }

  /**
   * 21_ADRs > ADR-088 — `PATCH /notifications/push-token`. 404s (rather
   * than 403) on a device that doesn't belong to the caller, same
   * ownership-hiding posture the repository method's own doc comment
   * explains — this service layer doesn't get enough information back to
   * distinguish "wrong owner" from "truly nonexistent" even if it wanted
   * to leak that distinction.
   */
  async updatePushToken(personId: string, dto: UpdatePushTokenDto): Promise<{ ok: true }> {
    const updated = await this.notifications.updateDevicePushToken(
      personId,
      dto.deviceToken,
      dto.pushToken,
    );
    if (!updated) {
      throw new NotFoundAppError('Device not found for this account.');
    }
    return { ok: true };
  }

  async getPreferences(personId: string) {
    return this.notifications.getOrCreatePreference(personId);
  }

  async updatePreferences(personId: string, dto: UpdatePreferenceDto, requestId: string) {
    const updated = await this.notifications.updatePreference(personId, dto);
    await this.audit.record({
      actorId: personId,
      action: 'PreferencesUpdated',
      entityType: 'NotificationPreference',
      entityId: personId,
      requestId,
    });
    return updated;
  }
}
