import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { DashboardService, DashboardOverview } from '../application/dashboard.service';

/**
 * 21_ADRs > ADR-110 — Backoffice Operational Dashboard. A single
 * read-only, cross-domain aggregation endpoint — "operational, not
 * decorative analytics" per the Stage 3 mandate. Deep per-domain detail
 * (the individual verification queues, fraud/compliance case lists,
 * finance ledgers, etc.) already has its own dedicated controller
 * elsewhere; this endpoint exists only to give staff a single at-a-glance
 * summary instead of opening every one of those screens separately.
 *
 * Same dual-guard Bridge Migration shape every ADR-102/ADR-108/ADR-109
 * controller already uses: `PLATFORM_ADMIN` (legacy floor) +
 * `DASHBOARD_VIEW` (new RBAC). No `DASHBOARD_MANAGE` — this controller
 * has no mutating action of its own, matching the AUDIT_VIEW/
 * MONITORING_VIEW precedent for a pure-read domain.
 *
 * Always returns HTTP 200 — `DashboardService.getOverview()` never
 * throws on a single section's failure (see its own doc comment); 500 is
 * reserved for a failure inside the aggregation pipeline itself, and
 * 401/403 follow the guards as normal.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/dashboard', version: '1' })
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('DASHBOARD_VIEW')
  async overview(): Promise<DashboardOverview> {
    return this.dashboard.getOverview();
  }
}
