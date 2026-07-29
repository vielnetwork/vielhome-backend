import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * Marketplace Access-Gate Implementation Phase, requirement 1 — a single
 * grant/revoke body rather than separate grant-only/revoke-only shapes,
 * so the same endpoint can move `isBackofficeApproved` in either
 * direction (`false -> true` or `true -> false`).
 */
export class SetBackofficeApprovalDto {
  @ApiProperty({ description: 'The new isBackofficeApproved value to set on the target Person.' })
  @IsBoolean()
  approved!: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
