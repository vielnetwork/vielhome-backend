import { ApiProperty } from '@nestjs/swagger';
import type { ServiceProviderCategory } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

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

  /**
   * Phone Number Input & Normalization task — tightens this field's
   * contract from free-form text (previously plain `@IsString()`, no
   * phone-shape validation at all) to the same Iranian-mobile-only rule
   * every other phone field in this API now enforces, for MVP
   * consistency (this product has no non-Iranian phone numbers anywhere
   * else). Accepts 09..., 9..., 989..., +989..., and Persian/Arabic-Indic
   * digit equivalents; normalized to +989XXXXXXXXX. No other Marketplace
   * behavior changes.
   */
  @ApiProperty({ required: false, example: '09121234567' })
  @IsOptional()
  @IsIranianMobilePhone()
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
