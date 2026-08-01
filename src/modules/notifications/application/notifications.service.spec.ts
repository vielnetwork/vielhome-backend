import { NotificationsService } from './notifications.service';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { NotificationPolicy } from '../domain/policies/notification.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError, BusinessRuleViolationError } from '../../../common/errors/app-error';
import { DISPATCH_DELIVERY_JOB } from './notification-dispatch.processor';

/**
 * 21_ADRs > ADR-114 — Notification Administration (Stage 7).
 *
 * `NotificationsService` itself predates this stage and has no prior unit
 * spec file — this file is scoped ONLY to `resendDelivery`, the single
 * new method ADR-114 adds. Covering `notify`/`markAsRead`/etc. (pre-
 * existing, out-of-scope behavior) is deliberately left out, matching
 * this roadmap's own "never touch out-of-scope areas" discipline; a
 * dedicated full-coverage spec for the rest of this class is residual
 * debt this stage inherits but does not introduce (see ADR-114's Risks
 * section).
 */
describe('NotificationsService.resendDelivery', () => {
  let notifications: {
    findDeliveryById: jest.Mock;
    resetDeliveryForResend: jest.Mock;
  };
  let dispatchQueue: { add: jest.Mock };
  let service: NotificationsService;

  const FAILED_DELIVERY = {
    id: 'delivery-1',
    channel: 'EMAIL' as const,
    status: 'FAILED' as const,
    notification: { buildingId: 'building-1' },
  };

  beforeEach(() => {
    notifications = {
      findDeliveryById: jest.fn(),
      resetDeliveryForResend: jest.fn().mockResolvedValue(undefined),
    };
    dispatchQueue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationsService(
      notifications as unknown as NotificationRepository,
      {} as unknown as NotificationPolicy,
      {} as unknown as AuditService,
      dispatchQueue as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('resets a FAILED delivery to PENDING and re-enqueues the dispatch job without a fixed jobId', async () => {
    notifications.findDeliveryById.mockResolvedValue(FAILED_DELIVERY);

    const result = await service.resendDelivery('delivery-1');

    expect(notifications.resetDeliveryForResend).toHaveBeenCalledWith('delivery-1');
    expect(dispatchQueue.add).toHaveBeenCalledWith(
      DISPATCH_DELIVERY_JOB,
      { deliveryId: 'delivery-1' },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );
    expect(dispatchQueue.add.mock.calls[0][2]).not.toHaveProperty('jobId');
    expect(result).toEqual({
      deliveryId: 'delivery-1',
      status: 'PENDING',
      channel: 'EMAIL',
      buildingId: 'building-1',
    });
  });

  it('throws NotFoundAppError when the delivery does not exist', async () => {
    notifications.findDeliveryById.mockResolvedValue(null);

    await expect(service.resendDelivery('missing')).rejects.toBeInstanceOf(NotFoundAppError);
    expect(notifications.resetDeliveryForResend).not.toHaveBeenCalled();
    expect(dispatchQueue.add).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'SENT', 'DELIVERED'])(
    'throws BusinessRuleViolationError when the delivery status is %s, not FAILED',
    async (status) => {
      notifications.findDeliveryById.mockResolvedValue({ ...FAILED_DELIVERY, status });

      await expect(service.resendDelivery('delivery-1')).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
      expect(notifications.resetDeliveryForResend).not.toHaveBeenCalled();
      expect(dispatchQueue.add).not.toHaveBeenCalled();
    },
  );
});
