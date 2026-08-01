import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-112 — Building Administration (Stage 5). Mandatory
 * `reason`, same rationale as `ReinstateBuildingDto`'s Person counterpart
 * (ADR-111) — reversing a lock is just as consequential a staff action
 * as issuing one and gets the same justification requirement.
 */
export class ReinstateBuildingDto {
  @ApiProperty({ description: 'Mandatory justification for reinstating this Building.' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
