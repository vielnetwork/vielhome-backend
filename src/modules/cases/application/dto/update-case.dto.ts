import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const CASE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const CASE_VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;

/**
 * Edits a case's own descriptive fields. Status changes go through the
 * dedicated `assign`/`resolve`/`close`/`reopen` actions instead, so each
 * transition gets its own business-rule check (`CasePolicy`) rather than
 * accepting an arbitrary status value here.
 */
export class UpdateCaseDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, enum: CASE_PRIORITIES })
  @IsOptional()
  @IsIn(CASE_PRIORITIES)
  priority?: (typeof CASE_PRIORITIES)[number];

  @ApiProperty({ required: false, enum: CASE_VISIBILITIES })
  @IsOptional()
  @IsIn(CASE_VISIBILITIES)
  visibility?: (typeof CASE_VISIBILITIES)[number];
}
