import { ApiProperty } from '@nestjs/swagger';
import type { CaseResolutionCode } from '@prisma/client';
import { IsEnum } from 'class-validator';

const RESOLUTION_CODES = [
  'COMPLETED',
  'REJECTED',
  'DUPLICATE',
  'INVALID',
  'EXTERNAL_RESOLUTION',
  'OTHER',
];

/**
 * 08.08 Rule 014 resolution code examples: COMPLETED, REJECTED, DUPLICATE,
 * INVALID, EXTERNAL_RESOLUTION. The source lists these as "Examples," not
 * an exhaustive set, so — mirroring `SupportCaseResolutionCode`'s own
 * identical "Examples" framing (07.05 Rule 015, ADR-032) — the fixed set
 * gains an `OTHER` catch-all rather than rejecting anything that doesn't
 * match one of the five named codes (21_ADRs > ADR-052).
 */
export class ResolveCaseDto {
  @ApiProperty({ enum: RESOLUTION_CODES })
  @IsEnum(RESOLUTION_CODES)
  resolutionCode!: CaseResolutionCode;
}
