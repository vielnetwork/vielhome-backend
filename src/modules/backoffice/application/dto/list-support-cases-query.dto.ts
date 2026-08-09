import { ApiPropertyOptional } from '@nestjs/swagger';
import { CaseStatus, SupportCaseCategory, VerificationPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/**
 * The staff Support queue's complete public filter contract. Prisma's
 * generated runtime enums are deliberately the single source of truth so
 * HTTP validation cannot drift from the values the repository can query.
 */
export class ListSupportCasesQueryDto {
  @ApiPropertyOptional({ enum: CaseStatus })
  @IsOptional()
  @IsEnum(CaseStatus)
  status?: CaseStatus;

  @ApiPropertyOptional({ enum: VerificationPriority })
  @IsOptional()
  @IsEnum(VerificationPriority)
  priority?: VerificationPriority;

  @ApiPropertyOptional({ enum: SupportCaseCategory })
  @IsOptional()
  @IsEnum(SupportCaseCategory)
  category?: SupportCaseCategory;

  @ApiPropertyOptional({ description: 'Person id of the assigned support staff member.' })
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
