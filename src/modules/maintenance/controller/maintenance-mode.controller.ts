import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { MaintenanceModeService } from '../application/maintenance-mode.service';
import { ToggleMaintenanceModeDto } from '../application/dto/toggle-maintenance-mode.dto';

/**
 * 21_ADRs > ADR-109 — global maintenance-mode status/toggle. Both routes
 * are on `MaintenanceModeMiddleware`'s exemption allowlist, by design:
 * whoever holds `MAINTENANCE_MODE_MANAGE` must always be able to reach
 * this controller, even while maintenance mode is currently enabled —
 * that is the entire admin-lockout-prevention mechanism for this ADR (see
 * that middleware's own doc comment).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/maintenance-mode', version: '1' })
export class MaintenanceModeController {
  constructor(private readonly service: MaintenanceModeService) {}

  @Get()
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('MAINTENANCE_MODE_VIEW')
  getStatus() {
    return this.service.getStatus();
  }

  @Patch()
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('MAINTENANCE_MODE_MANAGE')
  setEnabled(
    @Body() dto: ToggleMaintenanceModeDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.setEnabled(dto, user.sub, requestId);
  }
}
