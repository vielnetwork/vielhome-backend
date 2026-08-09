import { ApiPropertyOptional } from '@nestjs/swagger';
import { FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** Fraud queue filters, sourced directly from the queryable Prisma enums. */
export class ListFraudCasesQueryDto {
  @ApiPropertyOptional({ enum: FraudCaseStatus })
  @IsOptional()
  @IsEnum(FraudCaseStatus)
  status?: FraudCaseStatus;

  @ApiPropertyOptional({ enum: VerificationPriority })
  @IsOptional()
  @IsEnum(VerificationPriority)
  priority?: VerificationPriority;

  @ApiPropertyOptional({ description: 'Person id of the assigned fraud investigator.' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, type: Number })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, type: Number })
  @IsOptional()
  @IsString()
  limit?: string;
}
