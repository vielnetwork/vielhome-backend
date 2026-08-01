import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ProviderKey } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { ProviderSettingsService } from '../application/provider-settings.service';
import { ToggleProviderSettingDto } from '../application/dto/toggle-provider-setting.dto';

/**
 * 21_ADRs > ADR-116 — Global Provider Settings (Stage 9). Both routes
 * gated `PLATFORM_ADMIN` — matching `MaintenanceModeController`'s own
 * precedent for a comparably sensitive, platform-wide toggle: disabling
 * a live SMS/Email/Push provider is not a narrow, domain-scoped action
 * any lower legacy rank should reach.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/provider-settings', version: '1' })
export class ProviderSettingsController {
  constructor(private readonly service: ProviderSettingsService) {}

  @Get()
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('PROVIDER_SETTINGS_VIEW')
  list() {
    return this.service.list();
  }

  @Patch(':key')
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('PROVIDER_SETTINGS_MANAGE')
  setEnabled(
    @Param('key') key: ProviderKey,
    @Body() dto: ToggleProviderSettingDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.setEnabled(key, dto, user.sub, requestId);
  }
}
