import { ApiProperty } from '@nestjs/swagger';
import type { ServiceProviderCategory } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * ADR-097 — Marketplace Review Workflow (Phase 2), requirement 3/5.
 * `PATCH /marketplace/providers/:id` — owner-only edit, only reachable
 * while the listing is DRAFT or REJECTED (`ServiceProviderPolicy.
 * assertEditable`). Every field optional — a genuine partial update,
 * unlike `SubmitServiceProviderDto` where `name`/`category` are
 * required at creation time.
 */
export class UpdateServiceProviderDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    required: false,
    enum: ['MAINTENANCE', 'PROFESSIONAL_MANAGEMENT', 'INSURANCE', 'OTHER'],
  })
  @IsOptional()
  @IsEnum(['MAINTENANCE', 'PROFESSIONAL_MANAGEMENT', 'INSURANCE', 'OTHER'])
  category?: ServiceProviderCategory;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

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
