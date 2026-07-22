import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { NotificationCategory } from '@prisma/client';
import { NotificationsService } from '../application/notifications.service';
import { UpdatePushTokenDto } from '../application/dto/update-push-token.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Notifications MVP (13_Notification_Architecture v2.0, 08.10_
 * Notification_API — see 21_ADRs > ADR-027). Unlike every prior domain
 * controller, this one is NOT nested under `/buildings/:id/...` — every
 * route here is scoped to the caller's own notifications via their JWT
 * (`recipientId`), never another building's or another person's, so
 * there's no `:id` building param and no need for `MembershipGuard`/
 * `RolesGuard` anywhere in this controller — `JwtAuthGuard` alone is
 * sufficient, matching 08.10's own endpoint shapes exactly
 * (`GET /notifications`, not `GET /buildings/:id/notifications`).
 *
 * Route order matters: `unread-count` and `search` are registered before
 * `:notificationId` so Nest doesn't try to resolve those literal segments
 * as a notification ID — same lesson from DocumentsController's `search`.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('unread-count')
  getUnreadCount(@CurrentUser() user: JwtPayload) {
    return this.notifications.getUnreadCount(user.sub);
  }

  @Get('search')
  search(
    @CurrentUser() user: JwtPayload,
    @Query('title') title?: string,
    @Query('category') category?: NotificationCategory,
  ) {
    return this.notifications.searchNotifications(user.sub, { title, category });
  }

  @Post('read-all')
  markAllAsRead(@CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.notifications.markAllAsRead(user.sub, requestId);
  }

  /** 21_ADRs > ADR-088 — registers/refreshes the FCM push token for one of the caller's own already-logged-in devices. A literal segment, registered alongside `unread-count`/`search` above `:notificationId`, same reason as those two. */
  @Patch('push-token')
  updatePushToken(@CurrentUser() user: JwtPayload, @Body() dto: UpdatePushTokenDto) {
    return this.notifications.updatePushToken(user.sub, dto);
  }

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('category') category?: NotificationCategory,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.notifications.listNotifications(user.sub, {
      category,
      unreadOnly: unreadOnly === 'true',
      includeArchived: includeArchived === 'true',
    });
  }

  @Get(':notificationId')
  get(@Param('notificationId') notificationId: string, @CurrentUser() user: JwtPayload) {
    return this.notifications.getNotification(notificationId, user.sub);
  }

  @Post(':notificationId/read')
  markAsRead(
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.notifications.markAsRead(notificationId, user.sub, requestId);
  }

  /** Beyond 08.10's own endpoint list — realizes 10.09.01's in-app Notification Center's Unread/Read/Archived model, whose schema field (`archivedAt`) would otherwise be dead. */
  @Post(':notificationId/archive')
  archive(
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.notifications.archiveNotification(notificationId, user.sub, requestId);
  }
}
