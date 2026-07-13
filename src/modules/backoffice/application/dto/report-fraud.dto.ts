import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * 07.03 Rule 002 — a Report from an authorized user. This MVP accepts a
 * report from any authenticated Person rather than gating by role
 * (Owner/Tenant/Board Member/Manager per the source rule) — see
 * 21_ADRs > ADR-031 Decision for why that role-gate is deferred.
 * At least one of `targetPersonId`/`targetBuildingId` is required —
 * enforced in `FraudCaseService.report`, not here (cross-field checks
 * live in the service throughout this codebase, not in DTOs).
 */
export class ReportFraudDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetPersonId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetBuildingId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  description!: string;
}
