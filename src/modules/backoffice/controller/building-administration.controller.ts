import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BuildingAdministrationService } from '../application/building-administration.service';
import { LockBuildingDto } from '../application/dto/lock-building.dto';
import { ReinstateBuildingDto } from '../application/dto/reinstate-building.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { BuildingStatus } from '@prisma/client';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-112 — Building Administration (Stage 5). Reuses the
 * pre-existing, previously-unused `BUILDING_VIEW`/`BUILDING_EDIT`
 * permission keys (reserved since ADR-098, already granted to Operations
 * Admin, and `BUILDING_VIEW` alone to Finance Admin/Support Admin) rather
 * than introducing new ones — no schema/migration change in this stage.
 * Reads (list/detail) gated `REVIEWER`+ + `BUILDING_VIEW`; both mutations
 * (`lock`/`reinstate`) gated `SENIOR_REVIEWER`+ + `BUILDING_EDIT`,
 * matching `UserAdministrationController`'s own precedent for a
 * consequential, entity-affecting staff action distinct from this
 * entity's own case-based workflow (Building Verification Queue).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/buildings', version: '1' })
export class BuildingAdministrationController {
  constructor(private readonly service: BuildingAdministrationService) {}

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination), same convention as `UserAdministrationController.list`. */
  @Get()
  @PlatformRoles('REVIEWER')
  @RequiresPermission('BUILDING_VIEW')
  async list(
    @Query('search') search?: string,
    @Query('status') status?: BuildingStatus,
    @Query('hasRecoveryMode') hasRecoveryMode?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.list(
      {
        search,
        status,
        hasRecoveryMode: parseOptionalBoolean(hasRecoveryMode),
      },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':buildingId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('BUILDING_VIEW')
  getDetail(@Param('buildingId') buildingId: string) {
    return this.service.getDetail(buildingId);
  }

  @Post(':buildingId/lock')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('BUILDING_EDIT')
  lock(
    @Param('buildingId') buildingId: string,
    @Body() dto: LockBuildingDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.lock(buildingId, user.sub, dto.reason, requestId);
  }

  @Post(':buildingId/reinstate')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('BUILDING_EDIT')
  reinstate(
    @Param('buildingId') buildingId: string,
    @Body() dto: ReinstateBuildingDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.reinstate(buildingId, user.sub, dto.reason, requestId);
  }
}

/** Tolerant boolean query-param parsing, same "never throw on an
 * optional filter" discipline `parsePagination`/`UserAdministrationController`'s
 * own local helper already establish. */
function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}
