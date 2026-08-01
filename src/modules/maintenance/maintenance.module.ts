import { Module } from '@nestjs/common';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { MaintenanceModeController } from './controller/maintenance-mode.controller';
import { FeatureFlagController } from './controller/feature-flag.controller';
import { MaintenanceModeService } from './application/maintenance-mode.service';
import { FeatureFlagService } from './application/feature-flag.service';

/**
 * 21_ADRs > ADR-109 — Maintenance Mode & Feature Flags (Stage 2). Same
 * wiring template `MonitoringModule`/`SchedulerModule` already
 * established: import `BackOfficeModule` for `PlatformRolesGuard`'s own
 * `BackOfficeRepository` dependency, import `BackofficeRbacModule` for
 * `PermissionsGuard`, declare `PlatformRolesGuard` as a local provider
 * since `BackOfficeModule` does not export it. `MaintenanceModeService`
 * is exported because `AppModule`'s global `MaintenanceModeMiddleware`
 * needs it injected outside this module.
 */
@Module({
  imports: [BackOfficeModule, BackofficeRbacModule],
  controllers: [MaintenanceModeController, FeatureFlagController],
  providers: [MaintenanceModeService, FeatureFlagService, PlatformRolesGuard],
  exports: [MaintenanceModeService],
})
export class MaintenanceModule {}
