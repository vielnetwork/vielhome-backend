import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
} from '@prisma/client';
import { NotificationAdministrationService } from '../application/notification-administration.service';
import { ResendNotificationDeliveryDto } from '../application/dto/resend-notification-delivery.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-114 — Notification Administration (Stage 7). Introduces
 * `NOTIFICATION_DELIVERY_VIEW`/`NOTIFICATION_DELIVERY_MANAGE` — the first
 * genuinely new `PermissionKey` values (and accompanying migration) since
 * ADR-110's `DASHBOARD_VIEW`, since no dormant `NOTIFICATION_*` pair was
 * available to repurpose the way Stages 4-6 reused `USER_*`/`BUILDING_*`/
 * `FINANCE_*`. Reads (list/detail) gated `REVIEWER`+ + `NOTIFICATION_
 * DELIVERY_VIEW`; `resend` is `SENIOR_REVIEWER`+ + `NOTIFICATION_
 * DELIVERY_MANAGE`, matching this roadmap's own precedent for a
 * consequential, side-effecting staff action (`BuildingAdministrationController
 * .lock`/`FinanceAdministrationController.reverse`).
 *
 * Physically lives in `NotificationsModule` (see
 * `NotificationAdministrationService`'s own doc comment for why), but the
 * route path stays under `backoffice/...` for URL consistency with every
 * other Backoffice admin surface — matching `NotificationTemplateController`
 * 's own pre-existing `backoffice/notification-templates` precedent.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/notifications', version: '1' })
export class NotificationAdministrationController {
  constructor(private readonly service: NotificationAdministrationService) {}

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination), same convention as every other Backoffice admin list endpoint. */
  @Get()
  @PlatformRoles('REVIEWER')
  @RequiresPermission('NOTIFICATION_DELIVERY_VIEW')
  async list(
    @Query('search') search?: string,
    @Query('status') status?: NotificationDeliveryStatus,
    @Query('channel') channel?: NotificationChannel,
    @Query('category') category?: NotificationCategory,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.list(
      { search, status, channel, category },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  /** 21_ADRs > ADR-115 — Reports & Export (Stage 8). CSV export of the
   * same filtered result set `list` already returns, reusing
   * `NOTIFICATION_DELIVERY_VIEW` rather than a separate export-specific
   * permission — the same precedent `AuditController.export` already
   * established for `AUDIT_VIEW` (ADR-034). Declared BEFORE
   * `:deliveryId` so `GET .../export` is not swallowed by the id-param
   * route. */
  @Get('export')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('NOTIFICATION_DELIVERY_VIEW')
  async exportCsv(
    @Query('search') search: string | undefined,
    @Query('status') status: NotificationDeliveryStatus | undefined,
    @Query('channel') channel: NotificationChannel | undefined,
    @Query('category') category: NotificationCategory | undefined,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.service.exportCsv(
      { search, status, channel, category },
      user.sub,
      requestId,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="notification-deliveries-export.csv"',
    );
    res.send(csv);
  }

  @Get(':deliveryId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('NOTIFICATION_DELIVERY_VIEW')
  getDetail(@Param('deliveryId') deliveryId: string) {
    return this.service.getDetail(deliveryId);
  }

  @Post(':deliveryId/resend')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('NOTIFICATION_DELIVERY_MANAGE')
  resend(
    @Param('deliveryId') deliveryId: string,
    @Body() dto: ResendNotificationDeliveryDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.resend(deliveryId, user.sub, dto, requestId);
  }
}
