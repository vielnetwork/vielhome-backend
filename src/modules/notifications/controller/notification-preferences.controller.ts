import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from '../application/notifications.service';
import { UpdatePreferenceDto } from '../application/dto/update-preference.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** 08.10's own top-level `/notification-preferences` path — always the caller's own preferences (08.10 Rule 009: "Users Control Preferences"). */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'notification-preferences', version: '1' })
export class NotificationPreferencesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  getPreferences(@CurrentUser() user: JwtPayload) {
    return this.notifications.getPreferences(user.sub);
  }

  @Patch()
  updatePreferences(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePreferenceDto,
    @RequestId() requestId: string,
  ) {
    return this.notifications.updatePreferences(user.sub, dto, requestId);
  }
}
