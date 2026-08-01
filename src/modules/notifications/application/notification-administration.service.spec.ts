import { NotificationAdministrationService } from './notification-administration.service';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { NotificationsService } from './notifications.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * 21_ADRs > ADR-114 — Notification Administration (Stage 7).
 * `NotificationRepository`/`NotificationsService`/`AuditService` are all
 * fully mocked. Covers: `list`/`getDetail`'s pagination/404 contract
 * (raw-repository-call pattern), and `resend`'s full-domain-service-reuse
 * contract — it must call `NotificationsService.resendDelivery` (never
 * write to the repository directly for the mutation itself) and record a
 * distinctly-named `NotificationDeliveryResentByAdmin` audit entry with
 * the caller-supplied `reason` only after that call succeeds.
 */
describe('NotificationAdministrationService', () => {
  let notifications: {
    searchDeliveries: jest.Mock;
    getDeliveryAdminDetail: jest.Mock;
  };
  let notificationsService: { resendDelivery: jest.Mock };
  let audit: { record: jest.Mock };
  let service: NotificationAdministrationService;

  beforeEach(() => {
    notifications = {
      searchDeliveries: jest.fn(),
      getDeliveryAdminDetail: jest.fn(),
    };
    notificationsService = { resendDelivery: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationAdministrationService(
      notifications as unknown as NotificationRepository,
      notificationsService as unknown as NotificationsService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('delegates to the repository search and shapes the pagination envelope', async () => {
      notifications.searchDeliveries.mockResolvedValue({ items: [{ id: 'delivery-1' }], total: 1 });

      const result = await service.list({ status: 'FAILED' }, { page: 1, limit: 20 });

      expect(notifications.searchDeliveries).toHaveBeenCalledWith(
        { status: 'FAILED' },
        { skip: 0, take: 20 },
      );
      expect(result.items).toEqual([{ id: 'delivery-1' }]);
      expect(result.meta.total).toBe(1);
    });
  });

  describe('getDetail', () => {
    it('returns the delivery when found', async () => {
      notifications.getDeliveryAdminDetail.mockResolvedValue({ id: 'delivery-1' });

      const result = await service.getDetail('delivery-1');

      expect(result).toEqual({ id: 'delivery-1' });
    });

    it('throws NotFoundAppError when the delivery does not exist', async () => {
      notifications.getDeliveryAdminDetail.mockResolvedValue(null);

      await expect(service.getDetail('missing')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('resend', () => {
    it('delegates the mutation to NotificationsService.resendDelivery, then records a distinctly-named audit entry', async () => {
      notificationsService.resendDelivery.mockResolvedValue({
        deliveryId: 'delivery-1',
        status: 'PENDING',
        channel: 'EMAIL',
        buildingId: 'building-1',
      });

      const result = await service.resend(
        'delivery-1',
        'actor-1',
        { reason: 'Provider outage resolved, retry now.' },
        'req-1',
      );

      expect(notificationsService.resendDelivery).toHaveBeenCalledWith('delivery-1');
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'actor-1',
        buildingId: 'building-1',
        action: 'NotificationDeliveryResentByAdmin',
        entityType: 'NotificationDelivery',
        entityId: 'delivery-1',
        reason: 'Provider outage resolved, retry now.',
        requestId: 'req-1',
        metadata: { channel: 'EMAIL', previousStatus: 'FAILED' },
      });
      expect(result).toEqual({ deliveryId: 'delivery-1', status: 'PENDING' });
    });

    it('never writes an audit entry if the resend itself throws (e.g. delivery not FAILED)', async () => {
      notificationsService.resendDelivery.mockRejectedValue(new Error('not FAILED'));

      await expect(
        service.resend('delivery-1', 'actor-1', { reason: 'retry' }, 'req-1'),
      ).rejects.toThrow('not FAILED');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('passes through buildingId undefined when the notification is not building-scoped', async () => {
      notificationsService.resendDelivery.mockResolvedValue({
        deliveryId: 'delivery-2',
        status: 'PENDING',
        channel: 'PUSH',
        buildingId: null,
      });

      await service.resend('delivery-2', 'actor-1', { reason: 'retry' }, 'req-1');

      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ buildingId: undefined }));
    });
  });
});
