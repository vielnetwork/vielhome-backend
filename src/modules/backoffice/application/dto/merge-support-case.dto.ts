import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** 07.05 Rule 012 — merges the current case into another (the "same issue" case), closing this one. */
export class MergeSupportCaseDto {
  @ApiProperty()
  @IsString()
  intoCaseId!: string;
}
