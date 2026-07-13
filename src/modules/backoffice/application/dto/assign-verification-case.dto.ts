import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** 07.01 Rule 017 / 07.02 Rule 017 — cases may be assigned to a Reviewer/Senior Reviewer. */
export class AssignVerificationCaseDto {
  @ApiProperty()
  @IsString()
  assigneeId!: string;
}
