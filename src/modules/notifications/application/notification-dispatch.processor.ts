import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { EmailProviderService } from '../../../common/notification-providers/email-provider.service';
import { SmsProviderService } from '../../../common/notification-providers/sms-provider.service';
import { PushProviderService } from '../../../common/notification-providers/push-provider.service';

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
 * synchronous.
 *
 * 21_ADRs > ADR-088 — real Push/Email/SMS dispatch replaces the pure
 * log-stub each channel used to run unconditionally (ADR-027/ADR-039,
 * unchanged in shape here). Each channel independently falls back to the
 * EXACT pre-ADR-088 stub behavior (same log line, same `markDeliverySent`
 * call) whenever its own provider isn't configured OR the recipient has no
 * usable target for that channel (no `email`; no `Device` row with a
 * `pushToken`) — no regression for any environment without real providers
 * configured, including this sandbox's own e2e suite/CI. A real provider
 * throwing propagates out of `process()` uncaught — BullMQ's own
 * `attempts: 3`/exponential-backoff (set by `NotificationsService.notify`)
 * retries it, and `onFailed` below records a permanent `FAILED` status
 * only once retries are exhausted, exactly as this processor's own
 * pre-ADR-088 doc comment already anticipated ("a real provider will be
 * able to throw").
 *
 * Still always marks `SENT`, never `DELIVERED`, on a successful provider
 * call — accepted-by-provider is not the same guarantee as
 * confirmed-delivered-to-device, and none of SendGrid/Twilio/FCM's synchronous
 * HTTP responses used here report that; real delivery confirmation needs
 * each provider's own asynchronous webhook (SendGrid Event Webhook, Twilio
 * status callbacks — FCM's v1 API doesn't offer per-device delivery
 * confirmation at all), out of scope for this ADR and named in its own
 * Future Review.
 */
@Processor(NOTIFICATION_DISPATCH_QUEUE)
export class NotificationDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationDispatchProcessor.name);

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly emailProvider: EmailProviderService,
    private readonly smsProvider: SmsProviderService,
    private readonly pushProvider: PushProviderService,
  ) {
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

    const { notification } = delivery;
    const recipient = notification.recipient;

    switch (delivery.channel) {
      case 'EMAIL':
        if (this.emailProvider.isConfigured() && recipient.email) {
          await this.emailProvider.send({
            to: recipient.email,
            subject: notification.title,
            body: notification.body,
          });
          await this.notifications.markDeliverySent(deliveryId);
          return;
        }
        break;
      case 'SMS':
        // `recipient.phone` is a required field (every Person has one —
        // it's how they authenticate), so this branch is reachable
        // whenever `SmsProviderService` is configured, regardless of what
        // else is filled in on the recipient's profile.
        if (this.smsProvider.isConfigured()) {
          await this.smsProvider.send({
            to: recipient.phone,
            body: `${notification.title}: ${notification.body}`,
          });
          await this.notifications.markDeliverySent(deliveryId);
          return;
        }
        break;
      case 'PUSH':
        if (this.pushProvider.isConfigured() && recipient.devices.length > 0) {
          await this.dispatchPush(deliveryId, recipient.devices, notification);
          return;
        }
        break;
      default:
        break;
    }

    this.stubDispatch(delivery.channel, notification.recipientId, notification.title);
    await this.notifications.markDeliverySent(deliveryId);
  }

  /**
   * A person can have multiple registered devices. Sends to every one with
   * a `pushToken` (already filtered by `NotificationRepository.
   * findDeliveryById`'s own `include`) via `Promise.allSettled` — one
   * stale/uninstalled device's token going bad shouldn't block delivery to
   * the person's other devices. Marks `SENT` if AT LEAST ONE device
   * succeeded; if every attempted device failed, re-throws the first
   * failure so BullMQ retries the whole delivery (a device-specific
   * permanent failure, e.g. an uninstalled app whose token FCM will never
   * accept again, is not distinguished from a transient one here — no
   * source doc specifies per-device token pruning, named in Future Review).
   */
  private async dispatchPush(
    deliveryId: string,
    devices: Array<{ pushToken: string | null }>,
    notification: { title: string; body: string },
  ): Promise<void> {
    const results = await Promise.allSettled(
      devices
        .filter((device): device is { pushToken: string } => device.pushToken !== null)
        .map((device) =>
          this.pushProvider.send({
            token: device.pushToken,
            title: notification.title,
            body: notification.body,
          }),
        ),
    );

    const anySucceeded = results.some((result) => result.status === 'fulfilled');
    if (anySucceeded) {
      await this.notifications.markDeliverySent(deliveryId);
      return;
    }

    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    throw firstFailure?.reason instanceof Error
      ? firstFailure.reason
      : new Error('Push dispatch failed on every registered device.');
  }

  /** The exact pre-ADR-088 stub log line — unchanged so a diff against any earlier delivered version shows zero difference in this one path. */
  private stubDispatch(channel: string, recipientId: string, title: string): void {
    this.logger.log(`[notification-stub ${channel}] to person=${recipientId}: "${title}"`);
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
