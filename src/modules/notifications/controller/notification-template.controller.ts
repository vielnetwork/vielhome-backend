import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationTemplateService } from '../application/notification-template.service';
import { CreateNotificationTemplateDto } from '../application/dto/create-notification-template.dto';
import { UpdateNotificationTemplateDto } from '../application/dto/update-notification-template.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-060 — staff-managed notification copy library (08.10
 * Rules 011/012). Platform-wide, not building-scoped (same reasoning as
 * Marketplace Moderation, ADR-030 point 6) — reuses `PlatformStaff`/
 * `PlatformRolesGuard` rather than `RolesGuard`. Read access is
 * REVIEWER+; create/update is SENIOR_REVIEWER+, one tier above routine
 * moderation, since message copy is a system-wide asset every future
 * recipient sees, not a single case decision.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/notification-templates', version: '1' })
export class NotificationTemplateController {
  constructor(private readonly templates: NotificationTemplateService) {}

  @Get()
  @PlatformRoles('REVIEWER')
  list(@Query('isActive') isActive?: string) {
    return this.templates.list({ isActive: isActive === undefined ? undefined : isActive === 'true' });
  }

  @Get(':id')
  @PlatformRoles('REVIEWER')
  get(@Param('id') id: string) {
    return this.templates.get(id);
  }

  @Post()
  @PlatformRoles('SENIOR_REVIEWER')
  create(@Body() dto: CreateNotificationTemplateDto, @CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.templates.create(dto, user.sub, requestId);
  }

  @Patch(':id')
  @PlatformRoles('SENIOR_REVIEWER')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationTemplateDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.templates.update(id, dto, user.sub, requestId);
  }
}
