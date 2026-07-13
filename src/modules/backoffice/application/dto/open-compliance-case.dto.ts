import { ApiProperty } from '@nestjs/swagger';
import type { ComplianceCaseCategory, VerificationPriority } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';

const CATEGORIES = ['REPEATED_FRAUD', 'REPEATED_SUSPENSION', 'FINANCIAL_ANOMALY', 'OTHER'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

/** 07.06 Rule 011 — staff manually opens a Compliance Case (the auto-detection path is `POST /backoffice/compliance-cases/detect`). */
export class OpenComplianceCaseDto {
  @ApiProperty({ enum: CATEGORIES })
  @IsEnum(CATEGORIES)
  category!: ComplianceCaseCategory;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  subjectActorId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  linkedEntityType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  linkedEntityId?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  sourceAuditLogIds?: string[];

  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty({ required: false, enum: PRIORITIES })
  @IsOptional()
  @IsEnum(PRIORITIES)
  priority?: VerificationPriority;
}
