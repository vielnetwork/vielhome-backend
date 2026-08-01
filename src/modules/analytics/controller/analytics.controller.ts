import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { AnalyticsService, GrowthAnalytics } from '../application/analytics.service';

/**
 * 21_ADRs > ADR-117 — Backoffice Analytics (Growth & Trend Reporting),
 * Stage 10 (final stage of the Backoffice completion roadmap). Same
 * dual-guard shape `DashboardController` already established:
 * `PLATFORM_ADMIN` (legacy floor) + `ANALYTICS_VIEW` (new RBAC), no
 * `MANAGE` key — this controller has no mutating route of its own,
 * matching the AUDIT_VIEW/MONITORING_VIEW/DASHBOARD_VIEW/
 * GAMIFICATION_ANALYTICS_VIEW precedent for a pure-read domain.
 *
 * `fromDate`/`toDate` are plain optional query-param strings (not a DTO
 * class) — the same lightweight shape `GamificationController.
 * getAnalytics()` already uses for the same two optional read-only
 * params; `AnalyticsService.getGrowth` owns all range validation.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('growth')
  @PlatformRoles('PLATFORM_ADMIN')
  @RequiresPermission('ANALYTICS_VIEW')
  getGrowth(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ): Promise<GrowthAnalytics> {
    return this.analytics.getGrowth(fromDate, toDate);
  }
}
