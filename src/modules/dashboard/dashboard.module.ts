import { Module } from '@nestjs/common';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { DashboardController } from './controller/dashboard.controller';
import { DashboardService } from './application/dashboard.service';

/**
 * 21_ADRs > ADR-110 — Backoffice Operational Dashboard. Same
 * module-wiring template `MonitoringModule`/`MaintenanceModule` already
 * established: import `BackOfficeModule` (for `PlatformRolesGuard`'s own
 * `BackOfficeRepository` dependency) and `BackofficeRbacModule` (for
 * `PermissionsGuard`); `PlatformRolesGuard` is declared as its own local
 * provider here rather than imported from `BackOfficeModule` (which does
 * not export it) — same "own the guard, reuse the repository it depends
 * on" pattern every Bridge Migration module uses.
 *
 * Additionally imports `MonitoringModule` — this is the one new wiring
 * fact this stage introduces — purely to inject its exported
 * `MonitoringService` into `DashboardService`, so the dashboard's
 * `systemHealth` section reuses the exact same Postgres/Redis/BullMQ/
 * Storage aggregation `MonitoringService.getOverview()` already builds,
 * instead of duplicating that check logic here. No cycle risk:
 * `MonitoringModule` does not import `DashboardModule` (or anything that
 * transitively does).
 */
@Module({
  imports: [BackOfficeModule, BackofficeRbacModule, MonitoringModule],
  controllers: [DashboardController],
  providers: [DashboardService, PlatformRolesGuard],
})
export class DashboardModule {}
