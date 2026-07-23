import {
  NotificationDispatchProcessor,
  DISPATCH_DELIVERY_JOB,
} from './notification-dispatch.processor';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { EmailProviderService } from '../../../common/notification-providers/email-provider.service';
import { SmsProviderService } from '../../../common/notification-providers/sms-provider.service';
import { PushProviderService } from '../../../common/notification-providers/push-provider.service';

type Delivery = {
  id: string;
  channel: 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP';
  status: string;
  notification: {
    title: string;
    body: string;
    recipientId: string;
    recipient: {
      email: string | null;
      phone: string;
      devices: Array<{ pushToken: string | null }>;
    };
  };
};

function makeDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'delivery-1',
    channel: 'EMAIL',
    status: 'PENDING',
    notification: {
      title: 'Charge published',
      body: 'A new charge is ready for review.',
      recipientId: 'person-1',
      recipient: { email: 'owner@example.com', phone: '+15551234567', devices: [] },
    },
    ...overrides,
  };
}

function makeMocks(delivery: Delivery | null) {
  const notifications = {
    findDeliveryById: jest.fn().mockResolvedValue(delivery),
    markDeliverySent: jest.fn().mockResolvedValue(undefined),
    markDeliveryFailed: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationRepository;

  const emailProvider = {
    isConfigured: jest.fn().mockReturnValue(false),
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailProviderService;

  const smsProvider = {
    isConfigured: jest.fn().mockReturnValue(false),
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as SmsProviderService;

  const pushProvider = {
    isConfigured: jest.fn().mockReturnValue(false),
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as PushProviderService;

  return { notifications, emailProvider, smsProvider, pushProvider };
}

function makeJob(deliveryId = 'delivery-1') {
  return { name: DISPATCH_DELIVERY_JOB, data: { deliveryId } } as never;
}

describe('NotificationDispatchProcessor', () => {
  it('ignores a job whose name is not the dispatch job', async () => {
    const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(null);
    const processor = new NotificationDispatchProcessor(
      notifications,
      emailProvider,
      smsProvider,
      pushProvider,
    );
    await processor.process({ name: 'something-else', data: { deliveryId: 'x' } } as never);
    expect(notifications.findDeliveryById).not.toHaveBeenCalled();
  });

  it('skips a delivery that is no longer PENDING (already handled by an earlier attempt)', async () => {
    const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(
      makeDelivery({ status: 'SENT' }),
    );
    const processor = new NotificationDispatchProcessor(
      notifications,
      emailProvider,
      smsProvider,
      pushProvider,
    );
    await processor.process(makeJob());
    expect(notifications.markDeliverySent).not.toHaveBeenCalled();
  });

  describe('EMAIL channel', () => {
    it('falls back to the stub when EmailProviderService is not configured', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(makeDelivery());
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });

    it('falls back to the stub when configured but the recipient has no email', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(
        makeDelivery({
          notification: {
            ...makeDelivery().notification,
            recipient: { email: null, phone: '+1', devices: [] },
          },
        }),
      );
      (emailProvider.isConfigured as jest.Mock).mockReturnValue(true);
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });

    it('dispatches via the real provider when configured and the recipient has an email', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(makeDelivery());
      (emailProvider.isConfigured as jest.Mock).mockReturnValue(true);
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());
      expect(emailProvider.send).toHaveBeenCalledWith({
        to: 'owner@example.com',
        subject: 'Charge published',
        body: 'A new charge is ready for review.',
      });
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });

    it('propagates a real provider failure (for BullMQ to retry) instead of falling back', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(makeDelivery());
      (emailProvider.isConfigured as jest.Mock).mockReturnValue(true);
      (emailProvider.send as jest.Mock).mockRejectedValue(new Error('SendGrid 500'));
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await expect(processor.process(makeJob())).rejects.toThrow('SendGrid 500');
      expect(notifications.markDeliverySent).not.toHaveBeenCalled();
    });
  });

  describe('SMS channel', () => {
    it('dispatches via the real provider when configured — recipient.phone is always present', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(
        makeDelivery({ channel: 'SMS' }),
      );
      (smsProvider.isConfigured as jest.Mock).mockReturnValue(true);
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());
      expect(smsProvider.send).toHaveBeenCalledWith({
        to: '+15551234567',
        body: 'Charge published: A new charge is ready for review.',
      });
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });

    it('falls back to the stub when not configured', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(
        makeDelivery({ channel: 'SMS' }),
      );
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());
      expect(smsProvider.send).not.toHaveBeenCalled();
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });
  });

  describe('PUSH channel', () => {
    it('falls back to the stub when configured but the recipient has no devices', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(
        makeDelivery({ channel: 'PUSH' }),
      );
      (pushProvider.isConfigured as jest.Mock).mockReturnValue(true);
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());
      expect(pushProvider.send).not.toHaveBeenCalled();
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });

    it('sends to every device with a pushToken and marks SENT if at least one succeeds', async () => {
      const delivery = makeDelivery({
        channel: 'PUSH',
        notification: {
          ...makeDelivery().notification,
          recipient: {
            email: 'x@example.com',
            phone: '+1',
            devices: [{ pushToken: 'tokA' }, { pushToken: 'tokB' }],
          },
        },
      });
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(delivery);
      (pushProvider.isConfigured as jest.Mock).mockReturnValue(true);
      (pushProvider.send as jest.Mock)
        .mockRejectedValueOnce(new Error('stale token'))
        .mockResolvedValueOnce(undefined);

      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await processor.process(makeJob());

      expect(pushProvider.send).toHaveBeenCalledTimes(2);
      expect(notifications.markDeliverySent).toHaveBeenCalledWith('delivery-1');
    });

    it('throws when every device fails, so BullMQ retries', async () => {
      const delivery = makeDelivery({
        channel: 'PUSH',
        notification: {
          ...makeDelivery().notification,
          recipient: { email: 'x@example.com', phone: '+1', devices: [{ pushToken: 'tokA' }] },
        },
      });
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(delivery);
      (pushProvider.isConfigured as jest.Mock).mockReturnValue(true);
      (pushProvider.send as jest.Mock).mockRejectedValue(new Error('FCM unreachable'));

      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );
      await expect(processor.process(makeJob())).rejects.toThrow('FCM unreachable');
      expect(notifications.markDeliverySent).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('marks FAILED only once every configured attempt is exhausted', async () => {
      const { notifications, emailProvider, smsProvider, pushProvider } = makeMocks(null);
      const processor = new NotificationDispatchProcessor(
        notifications,
        emailProvider,
        smsProvider,
        pushProvider,
      );

      await processor.onFailed(
        { data: { deliveryId: 'd1' }, attemptsMade: 2, opts: { attempts: 3 } } as never,
        new Error('boom'),
      );
      expect(notifications.markDeliveryFailed).not.toHaveBeenCalled();

      await processor.onFailed(
        { data: { deliveryId: 'd1' }, attemptsMade: 3, opts: { attempts: 3 } } as never,
        new Error('boom'),
      );
      expect(notifications.markDeliveryFailed).toHaveBeenCalledWith('d1', 'boom');
    });
  });
});
