import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** 06.07 Rule 014: a closed/resolved case may be reopened, but only "with a reason." */
export class ReopenCaseDto {
  @ApiProperty()
  @IsString()
  reason!: string;
}
