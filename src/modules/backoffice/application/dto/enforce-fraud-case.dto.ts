import { ApiProperty } from '@nestjs/swagger';
import type { EnforcementActionType, EnforcementTargetType } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

const ACTION_TYPES = ['WARNING', 'TEMPORARY_RESTRICTION', 'VERIFICATION_REVOCATION', 'ACCOUNT_SUSPENSION'];
const TARGET_TYPES = ['PERSON', 'BUILDING', 'MANAGER_CLAIM'];

/**
 * 07.03 Rule 013/014/017 — issued only against a CONFIRMED case (enforced
 * in `FraudCaseService.enforce`, not here). Exactly one of
 * `targetPersonId`/`targetBuildingId`/`targetMembershipId` must match
 * `targetType` — also a service-level check, same cross-field convention
 * as `ReportFraudDto`.
 */
export class EnforceFraudCaseDto {
  @ApiProperty({ enum: ACTION_TYPES })
  @IsEnum(ACTION_TYPES)
  type!: EnforcementActionType;

  @ApiProperty({ enum: TARGET_TYPES })
  @IsEnum(TARGET_TYPES)
  targetType!: EnforcementTargetType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetPersonId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetBuildingId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetMembershipId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
