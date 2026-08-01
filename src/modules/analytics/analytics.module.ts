import { Module } from '@nestjs/common';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { GamificationModule } from '../gamification/gamification.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { AnalyticsController } from './controller/analytics.controller';
import { AnalyticsService } from './application/analytics.service';

/**
 * 21_ADRs > ADR-117 — Backoffice Analytics (Growth & Trend Reporting),
 * Stage 10 (final stage). Same wiring template every Bridge Migration
 * module already established: import `BackOfficeModule` (for
 * `PlatformRolesGuard`'s own `BackOfficeRepository` dependency) and
 * `BackofficeRbacModule` (for `PermissionsGuard`); `PlatformRolesGuard`
 * is declared as its own local provider since `BackOfficeModule` does
 * not export it.
 *
 * Additionally imports `GamificationModule` directly — the same
 * "import the module directly for its exported service" pattern
 * `DashboardModule` established for `MonitoringModule` (ADR-110) — purely
 * to inject its exported `GamificationService` so this endpoint's
 * `gamification` section reuses the exact same `getAnalytics()` computed
 * by `GamificationController`'s own pre-existing route, instead of
 * duplicating that logic here. No cycle risk: `GamificationModule` does
 * not import `AnalyticsModule` (or anything that transitively does).
 */
@Module({
  imports: [BackOfficeModule, BackofficeRbacModule, GamificationModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, PlatformRolesGuard],
})
export class AnalyticsModule {}
