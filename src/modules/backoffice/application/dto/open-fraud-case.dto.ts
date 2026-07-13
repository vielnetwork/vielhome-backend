import { ApiProperty } from '@nestjs/swagger';
import type { FraudSignalType, VerificationPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

const SIGNAL_TYPES = [
  'MULTIPLE_MANAGER_CLAIMS',
  'MASS_REGISTRATIONS',
  'SUSPICIOUS_BUILDING_CREATION',
  'EXCESSIVE_APPEALS',
  'ABNORMAL_ACTIVITY',
  'OTHER',
];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

/**
 * 07.03 Rule 001 — staff-opened case standing in for the not-yet-built
 * automatic signal detector (see the schema section header comment and
 * 21_ADRs > ADR-031 Decision).
 */
export class OpenFraudCaseDto {
  @ApiProperty({ enum: SIGNAL_TYPES })
  @IsEnum(SIGNAL_TYPES)
  signalType!: FraudSignalType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetPersonId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  targetBuildingId?: string;

  @ApiProperty({ required: false, enum: PRIORITIES })
  @IsOptional()
  @IsEnum(PRIORITIES)
  priority?: VerificationPriority;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;
}
