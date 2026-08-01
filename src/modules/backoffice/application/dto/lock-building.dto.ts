import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-112 — Building Administration (Stage 5). `reason` is
 * mandatory, same rationale as `SuspendPersonDto` (ADR-111) — Lock is
 * explicitly one of the action types this engagement's own General
 * Principles require a staff-supplied reason for.
 */
export class LockBuildingDto {
  @ApiProperty({ description: 'Mandatory justification for locking this Building.' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
