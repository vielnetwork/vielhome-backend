import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** 08.08 Rule 016 — merges the current case into another (the "same issue" case), closing this one. */
export class MergeCaseDto {
  @ApiProperty()
  @IsString()
  intoCaseId!: string;
}
