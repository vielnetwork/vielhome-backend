import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

  /** 21_ADRs > ADR-115 — Reports & Export (Stage 8). CSV export of the
   * same filtered result set `list` already returns, reusing
   * `BUILDING_VIEW` rather than a separate export-specific permission —
   * the same precedent `AuditController.export` already established for
   * `AUDIT_VIEW` (ADR-034). Declared BEFORE `:buildingId` so `GET
   * .../export` is not swallowed by the id-param route. */
  @Get('export')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('BUILDING_VIEW')
  async exportCsv(
    @Query('search') search: string | undefined,
    @Query('status') status: BuildingStatus | undefined,
    @Query('hasRecoveryMode') hasRecoveryMode: string | undefined,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.service.exportCsv(
      {
        search,
        status,
        hasRecoveryMode: parseOptionalBoolean(hasRecoveryMode),
      },
      user.sub,
      requestId,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="buildings-export.csv"');
    res.send(csv);
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
