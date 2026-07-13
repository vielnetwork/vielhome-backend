import { ApiProperty } from '@nestjs/swagger';
import type { SupportCaseCategory, VerificationPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

const CATEGORIES = ['TECHNICAL', 'BILLING', 'VERIFICATION', 'FRAUD', 'GOVERNANCE', 'OTHER'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

/** 07.05 Rule 001/002 — any authenticated Person may open a ticket. Staff may additionally set `priority` up front (member-facing route always uses the NORMAL default — see `SupportReportController`). */
export class OpenSupportCaseDto {
  @ApiProperty({ enum: CATEGORIES })
  @IsEnum(CATEGORIES)
  category!: SupportCaseCategory;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  subject!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  description!: string;

  @ApiProperty({ required: false, enum: PRIORITIES })
  @IsOptional()
  @IsEnum(PRIORITIES)
  priority?: VerificationPriority;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  linkedEntityType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  linkedEntityId?: string;
}
