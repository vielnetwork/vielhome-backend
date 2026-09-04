import { ProviderHttpError } from '../../../common/notification-providers/http-json.util';
import {
  NotificationDispatchProcessor,
  DISPATCH_DELIVERY_JOB,
} from './notification-dispatch.processor';

const base = {
  id: 'd1',
  channel: 'EMAIL',
  status: 'PENDING',
  notification: {
    title: 'private title',
    body: 'private body',
    recipientId: 'p1',
    recipient: { email: 'private@example.com', phone: '+15551234567', devices: [] },
  },
};

function setup(override: Record<string, unknown> = {}) {
  const delivery = { ...base, ...override };
  const repo = {
    findDeliveryById: jest.fn().mockResolvedValue(delivery),
    markDeliverySent: jest.fn(),
    markDeliveryFailed: jest.fn(),
  };
  const email = { isConfigured: jest.fn().mockReturnValue(true), send: jest.fn() };
  const sms = { isConfigured: jest.fn().mockReturnValue(true), send: jest.fn() };
  const push = { isConfigured: jest.fn().mockReturnValue(true), send: jest.fn() };
  const settings = { isEnabled: jest.fn().mockReturnValue(true) };
  const processor = new NotificationDispatchProcessor(
    repo as never,
    email as never,
    sms as never,
    push as never,
    settings as never,
  );
  const job = {
    name: DISPATCH_DELIVERY_JOB,
    data: { deliveryId: 'd1' },
    opts: { attempts: 3 },
  } as never;
  return { processor, repo, email, sms, push, settings, job };
}

describe('NotificationDispatchProcessor truthful outcomes', () => {
  it('allows IN_APP to become SENT without an external provider', async () => {
    const c = setup({ channel: 'IN_APP' });
    await c.processor.process(c.job);
    expect(c.repo.markDeliverySent).toHaveBeenCalledWith('d1');
    expect(c.email.send).not.toHaveBeenCalled();
  });

  it.each(['EMAIL', 'SMS', 'PUSH'] as const)(
    '%s configured and successful becomes SENT',
    async (channel) => {
      const notification =
        channel === 'PUSH'
          ? {
              ...base.notification,
              recipient: {
                ...base.notification.recipient,
                devices: [{ pushToken: 'secret-token' }],
              },
            }
          : base.notification;
      const c = setup({ channel, notification });
      await c.processor.process(c.job);
      expect(c.repo.markDeliverySent).toHaveBeenCalledWith('d1');
      expect({ EMAIL: c.email, SMS: c.sms, PUSH: c.push }[channel].send).toHaveBeenCalled();
    },
  );

  it.each(['EMAIL', 'SMS', 'PUSH'] as const)(
    '%s unconfigured becomes FAILED without a provider call',
    async (channel) => {
      const c = setup({ channel });
      ({ EMAIL: c.email, SMS: c.sms, PUSH: c.push })[channel].isConfigured.mockReturnValue(false);
      await c.processor.process(c.job);
      expect(c.repo.markDeliveryFailed).toHaveBeenCalledWith('d1', 'PROVIDER_NOT_CONFIGURED');
      expect(c.repo.markDeliverySent).not.toHaveBeenCalled();
      expect({ EMAIL: c.email, SMS: c.sms, PUSH: c.push }[channel].send).not.toHaveBeenCalled();
    },
  );

  it.each(['EMAIL', 'SMS', 'PUSH'] as const)(
    '%s disabled becomes FAILED without a provider call',
    async (channel) => {
      const c = setup({ channel });
      c.settings.isEnabled.mockReturnValue(false);
      await c.processor.process(c.job);
      expect(c.repo.markDeliveryFailed).toHaveBeenCalledWith('d1', 'PROVIDER_DISABLED');
      expect(c.repo.markDeliverySent).not.toHaveBeenCalled();
      expect({ EMAIL: c.email, SMS: c.sms, PUSH: c.push }[channel].send).not.toHaveBeenCalled();
    },
  );

  it('PUSH without an eligible device becomes FAILED without retry', async () => {
    const c = setup({ channel: 'PUSH' });
    await c.processor.process(c.job);
    expect(c.repo.markDeliveryFailed).toHaveBeenCalledWith('d1', 'NO_ELIGIBLE_DEVICE');
    expect(c.push.send).not.toHaveBeenCalled();
  });

  it.each([
    ['EMAIL', null],
    ['SMS', ''],
  ] as const)('%s without a destination becomes FAILED', async (channel, destination) => {
    const recipient = {
      ...base.notification.recipient,
      [channel === 'EMAIL' ? 'email' : 'phone']: destination,
    };
    const c = setup({ channel, notification: { ...base.notification, recipient } });
    await c.processor.process(c.job);
    expect(c.repo.markDeliveryFailed).toHaveBeenCalledWith('d1', 'NO_DESTINATION');
    expect(c.repo.markDeliverySent).not.toHaveBeenCalled();
  });

  it('a permanent provider rejection becomes sanitized FAILED without retry', async () => {
    const c = setup();
    c.email.send.mockRejectedValue(new ProviderHttpError('secret private@example.com', 400));
    await c.processor.process(c.job);
    expect(c.repo.markDeliveryFailed).toHaveBeenCalledWith('d1', 'PROVIDER_REQUEST_FAILED');
    expect(c.repo.markDeliverySent).not.toHaveBeenCalled();
    expect(JSON.stringify(c.repo.markDeliveryFailed.mock.calls)).not.toContain(
      'private@example.com',
    );
  });

  it('a transient provider failure remains PENDING while BullMQ retries', async () => {
    const c = setup();
    c.email.send.mockRejectedValue(new ProviderHttpError('secret', 503));
    await expect(c.processor.process(c.job)).rejects.toThrow('PROVIDER_REQUEST_FAILED');
    expect(c.repo.markDeliveryFailed).not.toHaveBeenCalled();
    expect(c.repo.markDeliverySent).not.toHaveBeenCalled();
  });

  it('marks a retryable failure FAILED only after retry exhaustion with sanitized reason', async () => {
    const c = setup();
    await c.processor.onFailed(
      {
        name: DISPATCH_DELIVERY_JOB,
        data: { deliveryId: 'd1' },
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as never,
      new Error('secret-token'),
    );
    expect(c.repo.markDeliveryFailed).not.toHaveBeenCalled();
    await c.processor.onFailed(
      {
        name: DISPATCH_DELIVERY_JOB,
        data: { deliveryId: 'd1' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as never,
      new Error('secret-token'),
    );
    expect(c.repo.markDeliveryFailed).toHaveBeenCalledWith('d1', 'DISPATCH_FAILED');
  });

  it('PUSH partial fan-out follows aggregate success semantics', async () => {
    const notification = {
      ...base.notification,
      recipient: {
        ...base.notification.recipient,
        devices: [{ pushToken: 'a' }, { pushToken: 'b' }],
      },
    };
    const c = setup({ channel: 'PUSH', notification });
    c.push.send.mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(undefined);
    await c.processor.process(c.job);
    expect(c.push.send).toHaveBeenCalledTimes(2);
    expect(c.repo.markDeliverySent).toHaveBeenCalledWith('d1');
  });

  it('PUSH all-device failure is never SENT', async () => {
    const notification = {
      ...base.notification,
      recipient: { ...base.notification.recipient, devices: [{ pushToken: 'a' }] },
    };
    const c = setup({ channel: 'PUSH', notification });
    c.push.send.mockRejectedValue(new ProviderHttpError('secret-token', 500));
    await expect(c.processor.process(c.job)).rejects.toThrow('PROVIDER_REQUEST_FAILED');
    expect(c.repo.markDeliverySent).not.toHaveBeenCalled();
  });
});
