import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SubscriptionService } from '../../backoffice/application/subscription.service';
import { ComplianceCaseService } from '../../backoffice/application/compliance-case.service';
import { VotingService } from '../../governance/application/voting.service';

export const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';

export const JOB_NAMES = {
  SUBSCRIPTION_EVALUATE_EXPIRY: 'subscription-evaluate-expiry',
  COMPLIANCE_DETECT_ANOMALIES: 'compliance-detect-anomalies',
  GOVERNANCE_AUTO_PUBLISH_VOTES: 'governance-auto-publish-votes',
  GOVERNANCE_AUTO_CLOSE_VOTES: 'governance-auto-close-votes',
} as const;

export type ScheduledJobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * This codebase's first real BullMQ worker (21_ADRs > ADR-036).
 * `@nestjs/bullmq`/`bullmq`/`ioredis` have been project dependencies —
 * with Redis config in `configuration.ts` and a `redis` service already
 * in `docker-compose.yml` — since early sprints, but never wired to
 * anything until now. This is the recurring "no scheduler exists" gap
 * ADR-024/025/026/028/029/031/032/033/034/035 each flagged in their own
 * Future Review sections (ten ADRs).
 *
 * Every case below is a system-triggered call into an already-built,
 * already-fully-specified staff-triggered stand-in method
 * (`SubscriptionService.evaluateExpiry`, `ComplianceCaseService.
 * detectAnomalies`, `VotingService.publishVote`/`closeVote`) — this
 * processor introduces no new business logic, only automatic scheduling
 * of logic that already existed and was deliberately shaped
 * (`actorPersonId: string | undefined`) to make this possible without a
 * fake "system" Person row. A `requestId` is synthesized per run since
 * there is no HTTP request to carry one.
 *
 * NOT wired here, and explicitly out of scope for this ADR (see its own
 * Future Review): Recovery Mode auto-expiry (no source rule specifies
 * what should actually happen at expiry, only that Recovery Mode is
 * "temporary"), Cases/Support SLA breach detection (no threshold
 * specified anywhere in the source documents), and `04.02` Rules 21/22's
 * Personal Property Mode 30-day auto-archive (the domain itself isn't
 * built yet). Wiring those would mean inventing the missing business
 * rule, not just automating an existing one — a different, larger piece
 * of work than "build the scheduler."
 */
@Processor(SCHEDULED_JOBS_QUEUE)
export class ScheduledJobsProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledJobsProcessor.name);

  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly compliance: ComplianceCaseService,
    private readonly voting: VotingService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const requestId = `scheduler:${job.name}:${job.id}`;
    this.logger.log(`Running scheduled job "${job.name}" (job id ${job.id})`);

    switch (job.name) {
      case JOB_NAMES.SUBSCRIPTION_EVALUATE_EXPIRY:
        return this.subscriptions.evaluateAllDueExpiries(requestId);
      case JOB_NAMES.COMPLIANCE_DETECT_ANOMALIES:
        return this.compliance.detectAnomalies(undefined, requestId);
      case JOB_NAMES.GOVERNANCE_AUTO_PUBLISH_VOTES:
        return this.voting.runAutoPublish(requestId);
      case JOB_NAMES.GOVERNANCE_AUTO_CLOSE_VOTES:
        return this.voting.runAutoClose(requestId);
      default:
        this.logger.warn(`Unknown scheduled job name: ${job.name}`);
        return null;
    }
  }
}
