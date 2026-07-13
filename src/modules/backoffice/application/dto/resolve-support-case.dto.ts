import { ApiProperty } from '@nestjs/swagger';
import type { SupportCaseResolutionCode } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

const RESOLUTION_CODES = ['USER_ERROR', 'CONFIGURATION_ISSUE', 'BUG_FIXED', 'DUPLICATE_REQUEST', 'NOT_REPRODUCIBLE', 'OTHER'];

/** 07.05 Rule 015 — a resolved ticket records a resolution code from the fixed set. */
export class ResolveSupportCaseDto {
  @ApiProperty({ enum: RESOLUTION_CODES })
  @IsEnum(RESOLUTION_CODES)
  resolutionCode!: SupportCaseResolutionCode;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  resolution?: string;
}
