import { Injectable } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
} from '@prisma/client';
import { NotificationRepository } from '../infrastructure/repositories/notification.repository';
import { NotificationsService } from './notifications.service';
import { ResendNotificationDeliveryDto } from './dto/resend-notification-delivery.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';

/**
 * 21_ADRs > ADR-114 — Notification Administration (Stage 7). Lives inside
 * `NotificationsModule`, not `BackOfficeModule` — a deliberate deviation
 * from `UserAdministrationService`/`BuildingAdministrationService`/
 * `FinanceAdministrationService` (ADR-111/ADR-112/ADR-113), all of which
 * live in `backoffice/application/`. `NotificationsModule` already
 * imports `BackOfficeModule` (for `NotificationTemplateController`'s
 * reuse of `PlatformRolesGuard`/`BackOfficeRepository`, ADR-060); adding
 * the reverse import here would create a module cycle. Naming still
 * follows this roadmap's own "*AdministrationService" convention for
 * consistency, even though the file lives in a different module — see
 * ADR-114's Decision section for the full reasoning.
 *
 * `list`/`getDetail` are pure cross-recipient reads over
 * `NotificationDelivery` — a raw-repository-call pattern (ADR-111/
 * ADR-112's own precedent), since there is no existing business-rule
 * policy or side effect to preserve for a read. `resend` instead reuses
 * the full `NotificationsService.resendDelivery` (ADR-113's
 * full-domain-service-reuse pattern) because re-driving a dispatch has
 * real external-provider side effects (Email/SMS/Push via
 * `NotificationDispatchProcessor`) that a raw repository write would
 * silently skip.
 */
@Injectable()
export class NotificationAdministrationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly notificationsService: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async list(
    filters: {
      status?: NotificationDeliveryStatus;
      channel?: NotificationChannel;
      category?: NotificationCategory;
      search?: string;
    },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.notifications.searchDeliveries(
      filters,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async getDetail(deliveryId: string) {
    const delivery = await this.notifications.getDeliveryAdminDetail(deliveryId);
    if (!delivery) {
      throw new NotFoundAppError('Notification delivery not found.');
    }
    return delivery;
  }

  /**
   * `NotificationsService.resendDelivery` owns the FAILED-status guard
   * and the reset+re-enqueue mechanics; this method's own job is the
   * staff-attribution half — the distinctly-named audit action
   * (`NotificationDeliveryResentByAdmin`, distinguishing this staff-direct
   * path from any future non-admin resend trigger) plus the mandatory
   * `reason`, same discipline every Suspend/Lock/Refund/Reinstate action
   * in this roadmap has followed.
   */
  async resend(
    deliveryId: string,
    actorPersonId: string,
    dto: ResendNotificationDeliveryDto,
    requestId: string,
  ) {
    const result = await this.notificationsService.resendDelivery(deliveryId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: result.buildingId ?? undefined,
      action: 'NotificationDeliveryResentByAdmin',
      entityType: 'NotificationDelivery',
      entityId: deliveryId,
      reason: dto.reason,
      requestId,
      metadata: { channel: result.channel, previousStatus: 'FAILED' },
    });

    return { deliveryId: result.deliveryId, status: result.status };
  }
}
