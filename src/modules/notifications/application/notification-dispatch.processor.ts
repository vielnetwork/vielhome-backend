import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { EmailProviderService } from '../../../common/notification-providers/email-provider.service';
import { SmsProviderService } from '../../../common/notification-providers/sms-provider.service';
import { PushProviderService } from '../../../common/notification-providers/push-provider.service';
import { ProviderHttpError } from '../../../common/notification-providers/http-json.util';
import { ProviderSettingsService } from '../../provider-settings/application/provider-settings.service';

export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch';
export const DISPATCH_DELIVERY_JOB = 'dispatch-delivery';
export interface DispatchDeliveryJobData {
  deliveryId: string;
}
type FailureReason =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_DISABLED'
  | 'NO_DESTINATION'
  | 'NO_ELIGIBLE_DEVICE'
  | 'PROVIDER_REQUEST_FAILED'
  | 'DISPATCH_FAILED';

class RetryableProviderError extends Error {
  constructor() {
    super('PROVIDER_REQUEST_FAILED');
  }
}

function isRetryable(error: unknown): boolean {
  return !(
    error instanceof ProviderHttpError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** External SENT means at least one real provider request succeeded. Permanent
 * eligibility/HTTP failures become FAILED immediately; transient failures keep
 * the existing bounded BullMQ retry budget. */
@Processor(NOTIFICATION_DISPATCH_QUEUE)
export class NotificationDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationDispatchProcessor.name);
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly emailProvider: EmailProviderService,
    private readonly smsProvider: SmsProviderService,
    private readonly pushProvider: PushProviderService,
    private readonly providerSettings: ProviderSettingsService,
  ) {
    super();
  }

  async process(job: Job<DispatchDeliveryJobData>): Promise<void> {
    if (job.name !== DISPATCH_DELIVERY_JOB) return;
    const { deliveryId } = job.data;
    const delivery = await this.notifications.findDeliveryById(deliveryId);
    if (!delivery || delivery.status !== 'PENDING') return;
    const { channel, notification } = delivery;
    if (channel === 'IN_APP') {
      await this.notifications.markDeliverySent(deliveryId);
      return;
    }
    const provider = { EMAIL: this.emailProvider, SMS: this.smsProvider, PUSH: this.pushProvider }[
      channel
    ];
    if (!provider.isConfigured()) return this.fail(deliveryId, channel, 'PROVIDER_NOT_CONFIGURED');
    if (!this.providerSettings.isEnabled(channel))
      return this.fail(deliveryId, channel, 'PROVIDER_DISABLED');

    const recipient = notification.recipient;
    if (channel === 'PUSH') {
      const devices = recipient.devices.filter(
        (device): device is typeof device & { pushToken: string } =>
          typeof device.pushToken === 'string' && device.pushToken.trim().length > 0,
      );
      if (devices.length === 0) return this.fail(deliveryId, channel, 'NO_ELIGIBLE_DEVICE');
      const results = await Promise.allSettled(
        devices.map((device) =>
          this.pushProvider.send({
            token: device.pushToken,
            title: notification.title,
            body: notification.body,
          }),
        ),
      );
      const succeeded = results.filter((result) => result.status === 'fulfilled').length;
      if (succeeded === 0) {
        const retryable = results.some(
          (result) => result.status === 'rejected' && isRetryable(result.reason),
        );
        return this.providerFailed(deliveryId, channel, retryable);
      }
      await this.notifications.markDeliverySent(deliveryId);
      this.logger.log(
        `notification-dispatch channel=PUSH outcome=PROVIDER_SUCCEEDED succeeded=${succeeded} failed=${results.length - succeeded}`,
      );
      return;
    }

    const destination = channel === 'EMAIL' ? recipient.email : recipient.phone;
    if (!destination?.trim()) return this.fail(deliveryId, channel, 'NO_DESTINATION');
    try {
      if (channel === 'EMAIL') {
        await this.emailProvider.send({
          to: destination,
          subject: notification.title,
          body: notification.body,
        });
      } else {
        await this.smsProvider.send({
          to: destination,
          body: `${notification.title}: ${notification.body}`,
        });
      }
    } catch (error) {
      return this.providerFailed(deliveryId, channel, isRetryable(error));
    }
    await this.notifications.markDeliverySent(deliveryId);
    this.logger.log(`notification-dispatch channel=${channel} outcome=PROVIDER_SUCCEEDED`);
  }

  private async fail(deliveryId: string, channel: string, reason: FailureReason): Promise<void> {
    await this.notifications.markDeliveryFailed(deliveryId, reason);
    this.logger.warn(`notification-dispatch channel=${channel} outcome=${reason} retryable=false`);
  }

  private async providerFailed(
    deliveryId: string,
    channel: string,
    retryable: boolean,
  ): Promise<void> {
    if (!retryable) return this.fail(deliveryId, channel, 'PROVIDER_REQUEST_FAILED');
    this.logger.warn(
      `notification-dispatch channel=${channel} outcome=PROVIDER_REQUEST_FAILED retryable=true`,
    );
    throw new RetryableProviderError();
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<DispatchDeliveryJobData> | undefined, error: Error): Promise<void> {
    if (!job || job.name !== DISPATCH_DELIVERY_JOB) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const reason =
      error instanceof RetryableProviderError ? 'PROVIDER_REQUEST_FAILED' : 'DISPATCH_FAILED';
    this.logger.error(`notification-dispatch outcome=${reason} retries_exhausted=true`);
    await this.notifications.markDeliveryFailed(job.data.deliveryId, reason);
  }
}
