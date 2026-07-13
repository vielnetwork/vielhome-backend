import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { ValidationError } from '../../../common/errors/app-error';
import { TriggerScheduledJobDto } from '../application/dto/trigger-scheduled-job.dto';
import { JOB_NAMES, SCHEDULED_JOBS_QUEUE } from '../application/scheduled-jobs.processor';

const VALID_JOB_NAMES: string[] = Object.values(JOB_NAMES);

/**
 * Manual, on-demand trigger for any of this codebase's 4 scheduled jobs
 * (21_ADRs > ADR-036) — for staff ops use, and for verifying the worker
 * end-to-end without waiting for its real cadence. Enqueues a genuine
 * one-off BullMQ job (not a synchronous call) onto the same queue the
 * repeatable jobs use, processed by the same `ScheduledJobsProcessor` —
 * triggering manually exercises the exact real path, not a shortcut
 * around it. `PLATFORM_ADMIN`-only, matching Legal Hold and the raw
 * Audit Log search endpoint's own gating (ADR-029/034).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/scheduler', version: '1' })
export class SchedulerController {
  constructor(@InjectQueue(SCHEDULED_JOBS_QUEUE) private readonly queue: Queue) {}

  @Post('trigger')
  @PlatformRoles('PLATFORM_ADMIN')
  async trigger(@Body() dto: TriggerScheduledJobDto) {
    if (!VALID_JOB_NAMES.includes(dto.jobName)) {
      throw new ValidationError(`Unknown job name. Valid values: ${VALID_JOB_NAMES.join(', ')}`);
    }
    const job = await this.queue.add(
      dto.jobName,
      {},
      { jobId: `manual:${dto.jobName}:${Date.now()}` },
    );
    return { jobId: job.id, jobName: dto.jobName, status: 'queued' };
  }
}
