import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RbacManagementService } from '../application/rbac-management.service';
import { AssignRoleDto } from '../application/dto/assign-role.dto';
import { GrantPermissionDto } from '../application/dto/grant-permission.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-099 §6 — backend-only management surface for the new
 * Role/Permission model (no frontend yet, per ADR-099's own non-goal).
 *
 * Bootstrap problem, deliberately resolved this way: these endpoints
 * cannot be gated by the NEW permission system — nobody holds any
 * permission through it yet (ADR-099's seed creates no `StaffRole` rows
 * for real staff), so gating "who can manage permissions" with the
 * permission system itself would lock everyone out on day one. Gated
 * instead by the EXISTING `PlatformRolesGuard`
 * (`@PlatformRoles('PLATFORM_ADMIN')`) — the old system remains the
 * authority over the new system's own administration for the duration
 * of the Bridge Migration (21_ADRs > ADR-098 Alternative C).
 */
@ApiTags('backoffice-rbac')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/rbac', version: '1' })
export class RbacManagementController {
  constructor(private readonly rbac: RbacManagementService) {}

  @Get('roles')
  @PlatformRoles('PLATFORM_ADMIN')
  async listRoles() {
    return withEnvelope(await this.rbac.listRoles());
  }

  @Get('permissions')
  @PlatformRoles('PLATFORM_ADMIN')
  async listPermissions() {
    return withEnvelope(await this.rbac.listPermissions());
  }

  @Get('staff/:staffId/roles')
  @PlatformRoles('PLATFORM_ADMIN')
  async listStaffRoles(@Param('staffId') staffId: string) {
    return withEnvelope(await this.rbac.listActiveRolesForStaff(staffId));
  }

  @Post('staff/:staffId/roles')
  @PlatformRoles('PLATFORM_ADMIN')
  async assignRole(
    @Param('staffId') staffId: string,
    @Body() dto: AssignRoleDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return withEnvelope(await this.rbac.assignRole(staffId, dto.roleId, user.sub, requestId));
  }

  @Post('staff-roles/:id/revoke')
  @PlatformRoles('PLATFORM_ADMIN')
  async revokeRole(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return withEnvelope(await this.rbac.revokeRole(id, user.sub, requestId));
  }

  @Post('roles/:roleId/permissions')
  @PlatformRoles('PLATFORM_ADMIN')
  async grantPermission(
    @Param('roleId') roleId: string,
    @Body() dto: GrantPermissionDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return withEnvelope(
      await this.rbac.grantPermission(roleId, dto.permissionKey, user.sub, requestId),
    );
  }

  @Post('role-permissions/:id/revoke')
  @PlatformRoles('PLATFORM_ADMIN')
  async revokePermission(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return withEnvelope(await this.rbac.revokePermission(id, user.sub, requestId));
  }
}
