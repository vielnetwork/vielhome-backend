import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { MonitoringService, MonitoringOverview } from '../application/monitoring.service';

/**
 * 21_ADRs > ADR-108 — Backoffice Monitoring & System Health. A new,
 * staff-only telemetry layer, entirely separate from `HealthController`'s
 * unauthenticated infra probes (`/health`, `/health/live`, `/health/ready`
 * — unchanged, ungated, and untouched by this ADR).
 *
 * `PLATFORM_ADMIN`-only for Phase 1 (matches Scheduler/Legal Hold's own
 * gating for platform-wide operational visibility), plus the new
 * `MONITORING_VIEW` permission — same dual-guard Bridge Migration shape
 * every ADR-102 controller already uses. No `MONITORING_MANAGE`: this
 * controller has no mutating actions (no retry/pause/resume/clear-queue),
 * so a single view-only key is sufficient for this phase.
 *
 * Always returns HTTP 200 with the real status embedded in the body when
 * a snapshot could be built at all — 401/403 follow the guards as normal;
 * 500 is reserved for a failure inside the aggregation pipeline itself,
 * never for one dependency being down (see `MonitoringService`'s own doc
 * comment).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/monitoring', version: '1' })
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('overview')
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('MONITORING_VIEW')
  async overview(): Promise<MonitoringOverview> {
    return this.monitoring.getOverview();
  }
}
