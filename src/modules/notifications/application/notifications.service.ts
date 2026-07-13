import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { NotificationCategory, NotificationChannel, NotificationPriority } from '@prisma/client';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { NotificationPolicy } from '../domain/policies/notification.policy';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
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
   */
  async notify(input: NotifyInput): Promise<void> {
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
