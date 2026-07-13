import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { GovernanceModule } from '../governance/governance.module';
import { SchedulerController } from './controller/scheduler.controller';
import { ScheduledJobsProcessor, SCHEDULED_JOBS_QUEUE } from './application/scheduled-jobs.processor';
import { SchedulerBootstrapService } from './application/scheduler-bootstrap.service';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';

/**
 * This codebase's first real BullMQ worker (21_ADRs > ADR-036) — see
 * `ScheduledJobsProcessor`'s own header comment for the full "ten ADRs
 * flagged this gap" history and exactly what is/isn't wired.
 *
 * Imports `BackOfficeModule`/`GovernanceModule` directly rather than
 * going through the event pipeline: a scheduler that must actively CALL
 * specific business methods (`evaluateExpiry`, `detectAnomalies`,
 * `publishVote`/`closeVote`) on a timer is architecturally closer to a
 * controller than to the event-listener pattern every domain module
 * otherwise uses to stay decoupled. `PlatformRolesGuard` is declared as
 * its own provider here rather than exported from `BackOfficeModule`,
 * the same "own the guard, reuse the repository it depends on" pattern
 * `MarketplaceModule` already established (ADR-030).
 *
 * **Update (21_ADRs > ADR-054):** the `BullModule.forRootAsync(...)` Redis
 * connection config this module used to own directly has moved to its own
 * shared `QueueConfigModule` (registered once, globally, in `AppModule`),
 * since `NotificationsModule` (ADR-039) became a second, unrelated consumer
 * of that same connection. This module now only registers the one queue
 * (`SCHEDULED_JOBS_QUEUE`) it actually owns.
 */
@Module({
  imports: [BullModule.registerQueue({ name: SCHEDULED_JOBS_QUEUE }), BackOfficeModule, GovernanceModule],
  controllers: [SchedulerController],
  providers: [ScheduledJobsProcessor, SchedulerBootstrapService, PlatformRolesGuard],
})
export class SchedulerModule {}
