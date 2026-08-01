import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-111 — User Administration (Stage 4). `reason` is
 * mandatory here — unlike the pre-existing, out-of-scope
 * `SetBackofficeApprovalDto.reason` (optional) — per this engagement's
 * own General Principles: Suspend is explicitly listed as one of the
 * action types that must always carry a staff-supplied reason.
 */
export class SuspendPersonDto {
  @ApiProperty({ description: 'Mandatory justification for suspending this Person.' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
