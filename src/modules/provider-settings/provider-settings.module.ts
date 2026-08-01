import { Module } from '@nestjs/common';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { ProviderSettingsController } from './controller/provider-settings.controller';
import { ProviderSettingsService } from './application/provider-settings.service';

/**
 * 21_ADRs > ADR-116 — Global Provider Settings (Stage 9). Same wiring
 * template `MaintenanceModule`/`MonitoringModule` already established:
 * import `BackOfficeModule` for `PlatformRolesGuard`'s own
 * `BackOfficeRepository` dependency, import `BackofficeRbacModule` for
 * `PermissionsGuard`, declare `PlatformRolesGuard` as a local provider
 * since `BackOfficeModule` does not export it.
 *
 * `EmailProviderService`/`SmsProviderService`/`PushProviderService` need
 * no import here — `NotificationProvidersModule` is `@Global()` (ADR-088),
 * injectable anywhere without a per-module import, same as `AuditService`.
 *
 * `ProviderSettingsService` is exported because `NotificationsModule`'s
 * own `NotificationDispatchProcessor` needs it injected outside this
 * module — the same "import the settings module directly for its
 * exported service" pattern `DashboardModule` established for
 * `MonitoringModule` (ADR-110).
 */
@Module({
  imports: [BackOfficeModule, BackofficeRbacModule],
  controllers: [ProviderSettingsController],
  providers: [ProviderSettingsService, PlatformRolesGuard],
  exports: [ProviderSettingsService],
})
export class ProviderSettingsModule {}
