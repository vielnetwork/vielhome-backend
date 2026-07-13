import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsController } from './controller/notifications.controller';
import { NotificationPreferencesController } from './controller/notification-preferences.controller';
import { NotificationTemplateController } from './controller/notification-template.controller';
import { NotificationsService } from './application/notifications.service';
import { NotificationEventListener } from './application/notification-event-listener.service';
import { NotificationTemplateService } from './application/notification-template.service';
import { NotificationDispatchProcessor, NOTIFICATION_DISPATCH_QUEUE } from './application/notification-dispatch.processor';
import { NotificationRepository } from './infrastructure/repositories/notification.repository';
import { NotificationTemplateRepository } from './infrastructure/repositories/notification-template.repository';
import { NotificationPolicy } from './domain/policies/notification.policy';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { BuildingModule } from '../building/building.module';
import { BackOfficeModule } from '../backoffice/backoffice.module';

@Module({
  // Reuses BuildingRepository's recipient-resolution helpers (added this
  // sprint — listCurrentMemberPersonIds/listCurrentMemberPersonIdsByRoles/
  // getCurrentOwnerPersonIds) to turn a domain event's buildingId/unitId
  // into "who should be notified," without importing Finance/Governance/
  // Cases/Documents — `NotificationEventListener` only needs their EVENT
  // TYPES (type-only imports, no runtime module dependency) to react to
  // events emitted anywhere in the app via the global EventEmitter2.
  //
  // `BullModule.registerQueue({ name: NOTIFICATION_DISPATCH_QUEUE })`
  // (21_ADRs > ADR-039) deliberately does NOT also call
  // `BullModule.forRootAsync(...)` here — that global connection config
  // lives in its own shared `QueueConfigModule` (21_ADRs > ADR-054,
  // registered once, globally, in `AppModule`), and `@nestjs/bullmq`
  // registers it as a `@Global()` dynamic module, so this module's
  // `registerQueue()` call reuses the same Redis connection without
  // redeclaring it. This used to point at `SchedulerModule` (ADR-036)
  // instead — an accidental, undocumented coupling between two unrelated
  // feature modules, closed by ADR-054 once a second consumer (this
  // module) made the coupling worth naming and extracting properly.
  //
  // `BackOfficeModule` (21_ADRs > ADR-060) is imported for one reason only:
  // `NotificationTemplateController` reuses `PlatformRolesGuard` (and the
  // `BackOfficeRepository` it depends on) rather than inventing a second
  // platform-staff authorization mechanism — the same narrow,
  // single-purpose import Marketplace already established for its own
  // moderation controller (ADR-030 point 6). No other part of this module
  // touches BackOffice.
  imports: [
    BuildingModule,
    BackOfficeModule,
    BullModule.registerQueue({ name: NOTIFICATION_DISPATCH_QUEUE }),
  ],
  controllers: [NotificationsController, NotificationPreferencesController, NotificationTemplateController],
  providers: [
    NotificationsService,
    NotificationEventListener,
    NotificationTemplateService,
    NotificationDispatchProcessor,
    NotificationRepository,
    NotificationTemplateRepository,
    NotificationPolicy,
    PlatformRolesGuard,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
