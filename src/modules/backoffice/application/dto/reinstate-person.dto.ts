import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-111 — User Administration (Stage 4). Mandatory `reason`,
 * same rationale as `SuspendPersonDto` — reversing a suspension is just
 * as consequential a staff action as issuing one and gets the same
 * justification requirement.
 */
export class ReinstatePersonDto {
  @ApiProperty({ description: 'Mandatory justification for reinstating this Person.' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
