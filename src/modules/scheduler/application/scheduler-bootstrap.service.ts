import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JOB_NAMES, SCHEDULED_JOBS_QUEUE } from './scheduled-jobs.processor';

/**
 * Registers this codebase's first repeatable BullMQ jobs on app startup
 * (21_ADRs > ADR-036). A fixed `jobId` per job name makes registration
 * idempotent — BullMQ keys a repeatable job by its name/id/repeat-options
 * tuple, so re-registering the identical job on every app restart updates
 * it in place rather than creating a duplicate.
 *
 * Cadences are this ADR's own reasoned choice, disclosed rather than
 * derived from any source rule (none specifies one): Governance's vote
 * auto-publish/auto-close runs every 5 minutes since `startAt`/`endAt`
 * are minute-precision fields a daily sweep would leave stale for up to
 * 24 hours; Subscription's `evaluateExpiry` and Compliance's
 * `detectAnomalies` run once daily, an hour apart, with no functional
 * reason for the offset beyond not hitting the database at the exact
 * same instant.
 */
@Injectable()
export class SchedulerBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerBootstrapService.name);

  constructor(@InjectQueue(SCHEDULED_JOBS_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    await this.queue.add(
      JOB_NAMES.GOVERNANCE_AUTO_PUBLISH_VOTES,
      {},
      { jobId: JOB_NAMES.GOVERNANCE_AUTO_PUBLISH_VOTES, repeat: { pattern: '*/5 * * * *' } },
    );
    await this.queue.add(
      JOB_NAMES.GOVERNANCE_AUTO_CLOSE_VOTES,
      {},
      { jobId: JOB_NAMES.GOVERNANCE_AUTO_CLOSE_VOTES, repeat: { pattern: '*/5 * * * *' } },
    );
    await this.queue.add(
      JOB_NAMES.SUBSCRIPTION_EVALUATE_EXPIRY,
      {},
      { jobId: JOB_NAMES.SUBSCRIPTION_EVALUATE_EXPIRY, repeat: { pattern: '0 3 * * *' } },
    );
    await this.queue.add(
      JOB_NAMES.COMPLIANCE_DETECT_ANOMALIES,
      {},
      { jobId: JOB_NAMES.COMPLIANCE_DETECT_ANOMALIES, repeat: { pattern: '0 4 * * *' } },
    );

    this.logger.log(
      'Registered 4 repeatable scheduled jobs (governance auto-publish/auto-close, subscription evaluate-expiry, compliance detect-anomalies).',
    );
  }
}
