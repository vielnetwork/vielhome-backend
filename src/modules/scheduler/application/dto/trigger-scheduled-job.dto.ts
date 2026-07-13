import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** One of `JOB_NAMES` (`scheduled-jobs.processor.ts`) — validated against that list in `SchedulerController.trigger`, not here, since class-validator has no clean "one of this const object's values" decorator without duplicating the list. */
export class TriggerScheduledJobDto {
  @ApiProperty()
  @IsString()
  jobName!: string;
}
