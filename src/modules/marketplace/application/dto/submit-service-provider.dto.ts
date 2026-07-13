import { ApiProperty } from '@nestjs/swagger';
import type { ServiceProviderCategory } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';

/** ADR-030 — any authenticated Person may submit a listing; it starts PENDING. */
export class SubmitServiceProviderDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: ['MAINTENANCE', 'PROFESSIONAL_MANAGEMENT', 'INSURANCE', 'OTHER'] })
  @IsEnum(['MAINTENANCE', 'PROFESSIONAL_MANAGEMENT', 'INSURANCE', 'OTHER'])
  category!: ServiceProviderCategory;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  city?: string;
}
