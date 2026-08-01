import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { StorageModule } from '../../common/storage/storage.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { SCHEDULED_JOBS_QUEUE } from '../scheduler/application/scheduled-jobs.processor';
import { NOTIFICATION_DISPATCH_QUEUE } from '../notifications/application/notification-dispatch.processor';
import { MonitoringController } from './controller/monitoring.controller';
import { MonitoringService } from './application/monitoring.service';

/**
 * 21_ADRs > ADR-108 — Backoffice Monitoring & System Health. Same
 * module-wiring template `SchedulerModule` already established: import
 * `BackOfficeModule` (for `PlatformRolesGuard`'s own `BackOfficeRepository`
 * dependency) and `BackofficeRbacModule` (for `PermissionsGuard`), and
 * independently register whichever queues this module needs read-only
 * (`@InjectQueue`) access to — safe to call `BullModule.registerQueue`
 * for a queue name another module (`SchedulerModule`/`NotificationsModule`)
 * already registered; both share the one global Redis connection
 * `QueueConfigModule` provides. `PlatformRolesGuard` is declared as its
 * own local provider here rather than imported from `BackOfficeModule`
 * (which does not export it) — the same "own the guard, reuse the
 * repository it depends on" pattern `SchedulerModule`/`MarketplaceModule`
 * already established. `StorageModule` is technically `@Global()` already
 * (imported once in `AppModule`) and so `StorageService` would be
 * injectable here regardless — imported explicitly anyway for this
 * module's own import-list clarity about what it actually depends on.
 *
 * No cycle risk: this module is never imported back into any of
 * `BackOfficeModule`/`BackofficeRbacModule`/`SchedulerModule`/
 * `NotificationsModule`/`StorageModule`.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: SCHEDULED_JOBS_QUEUE }, { name: NOTIFICATION_DISPATCH_QUEUE }),
    BackOfficeModule,
    BackofficeRbacModule,
    StorageModule,
  ],
  controllers: [MonitoringController],
  providers: [MonitoringService, PlatformRolesGuard],
})
export class MonitoringModule {}
