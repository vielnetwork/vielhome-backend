import { ApiPropertyOptional } from '@nestjs/swagger';
import { ComplianceCaseCategory, FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** Compliance queue filters sourced directly from the queryable Prisma enums. */
export class ListComplianceCasesQueryDto {
  @ApiPropertyOptional({ enum: FraudCaseStatus })
  @IsOptional()
  @IsEnum(FraudCaseStatus)
  status?: FraudCaseStatus;

  @ApiPropertyOptional({ enum: ComplianceCaseCategory })
  @IsOptional()
  @IsEnum(ComplianceCaseCategory)
  category?: ComplianceCaseCategory;

  @ApiPropertyOptional({ enum: VerificationPriority })
  @IsOptional()
  @IsEnum(VerificationPriority)
  priority?: VerificationPriority;

  @ApiPropertyOptional({ description: 'Person id of the assigned compliance investigator.' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Person id that is the subject of the compliance case.' })
  @IsOptional()
  @IsString()
  subjectActorId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, type: Number })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, type: Number })
  @IsOptional()
  @IsString()
  limit?: string;
}
