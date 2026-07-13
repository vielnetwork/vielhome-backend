import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';

export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch';
export const DISPATCH_DELIVERY_JOB = 'dispatch-delivery';

export interface DispatchDeliveryJobData {
  deliveryId: string;
}

/**
 * Real async notification dispatch (21_ADRs > ADR-039), closing the gap
 * ADR-027's own Future Review named the moment Notifications shipped:
 * "`@nestjs/bullmq`/`bullmq` are already declared dependencies with zero
 * usage anywhere in `src` — dispatch runs synchronously in-request for
 * now." That stayed true through ADR-036 (which finally put BullMQ to
 * work, but only for scheduled/repeatable jobs, not this). This processor
 * reuses the exact `WorkerHost`/`@Processor()` shape `ScheduledJobsProcessor`
 * established, applied to a one-shot job per `NotificationDelivery` instead
 * of a repeatable cron job — same worker infrastructure, different job
 * pattern.
 *
 * Only non-IN_APP channels ever reach this queue — see
 * `NotificationsService.notify`'s own doc comment for why IN_APP stays
 * synchronous. The dispatch itself is still the same log-stub
 * `NotificationsService.notify` used to run inline (no real Push/Email/SMS
 * provider exists yet, unchanged by this ADR) — what moved is WHERE it
 * runs (a background worker, not the original event-triggered request),
 * not WHAT it does.
 */
@Processor(NOTIFICATION_DISPATCH_QUEUE)
export class NotificationDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationDispatchProcessor.name);

  constructor(private readonly notifications: NotificationRepository) {
    super();
  }

  async process(job: Job<DispatchDeliveryJobData>): Promise<void> {
    if (job.name !== DISPATCH_DELIVERY_JOB) return;
    const { deliveryId } = job.data;

    const delivery = await this.notifications.findDeliveryById(deliveryId);
    if (!delivery) {
      // Defensive only — a delivery row is created in the same transaction
      // as the Notification, before the job is ever enqueued, so this
      // should be unreachable in practice.
      this.logger.warn(`NotificationDelivery ${deliveryId} not found — skipping.`);
      return;
    }
    if (delivery.status !== 'PENDING') {
      // Already dispatched (e.g. a retried job whose earlier attempt
      // actually succeeded before erroring elsewhere) — don't double-log
      // or overwrite a terminal status.
      return;
    }

    // Stub dispatch — same "model the real shape, stub the missing
    // infrastructure" pattern as OTP delivery and Documents' file storage.
    // Always marked SENT (dispatched to the stub), never DELIVERED — there
    // is no real provider to confirm receipt (ADR-027, unchanged here).
    this.logger.log(
      `[notification-stub ${delivery.channel}] to person=${delivery.notification.recipientId}: "${delivery.notification.title}"`,
    );
    await this.notifications.markDeliverySent(deliveryId);
  }

  /**
   * Wires up `NotificationRepository.markDeliveryFailed` — a method that
   * has existed since ADR-027 with no caller anywhere in the codebase,
   * since a synchronous stub-log can't meaningfully fail. A real BullMQ
   * job can: this only records FAILED once every configured attempt
   * (`attempts: 3` on the job options `NotificationsService.notify` sets)
   * is exhausted — an earlier, automatically-retried failure should not
   * mark the delivery FAILED while BullMQ is still going to try again.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<DispatchDeliveryJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade < attemptsAllowed) return;

    this.logger.error(
      `Dispatch permanently failed for delivery ${job.data.deliveryId} after ${job.attemptsMade} attempt(s): ${error.message}`,
    );
    await this.notifications.markDeliveryFailed(job.data.deliveryId, error.message);
  }
}
