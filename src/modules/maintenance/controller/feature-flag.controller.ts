import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
import { FeatureFlagService } from '../application/feature-flag.service';
import { CreateFeatureFlagDto } from '../application/dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from '../application/dto/update-feature-flag.dto';

/**
 * 21_ADRs > ADR-109 — centralized, platform-wide operational
 * feature-toggle registry. NOT on `MaintenanceModeMiddleware`'s exemption
 * allowlist (only Maintenance Mode's own routes are) — this is an
 * ordinary Backoffice admin surface, not a recovery path.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/feature-flags', version: '1' })
export class FeatureFlagController {
  constructor(private readonly service: FeatureFlagService) {}

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination). */
  @Get()
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('FEATURE_FLAGS_VIEW')
  async list(
    @Query('enabled') enabled?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.list(
      { enabled: enabled === undefined ? undefined : enabled === 'true', search },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':key')
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('FEATURE_FLAGS_VIEW')
  getByKey(@Param('key') key: string) {
    return this.service.getByKey(key);
  }

  @Post()
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('FEATURE_FLAGS_MANAGE')
  create(
    @Body() dto: CreateFeatureFlagDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.create(dto, user.sub, requestId);
  }

  @Patch(':key')
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('FEATURE_FLAGS_MANAGE')
  update(
    @Param('key') key: string,
    @Body() dto: UpdateFeatureFlagDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.update(key, dto, user.sub, requestId);
  }
}
