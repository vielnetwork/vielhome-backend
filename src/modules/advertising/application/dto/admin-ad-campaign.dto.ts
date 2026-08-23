import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  AdCampaignSource,
  AdCampaignStatus,
  AdExternalProvider,
  AdPlacement,
  AdSlotFillStrategy,
} from '@prisma/client';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const AD_CAMPAIGN_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const AD_CAMPAIGN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export class RequestAdminAdCampaignImageUploadDto {
  @IsString() fileName!: string;
  @IsIn(AD_CAMPAIGN_IMAGE_MIME_TYPES) contentType!: string;
  @IsInt() @Min(1) @Max(AD_CAMPAIGN_IMAGE_MAX_BYTES) fileSize!: number;
  @IsOptional() @IsString() campaignId?: string;
}

export class CreateAdminAdCampaignDto {
  @IsString() name!: string;
  @IsEnum(AdCampaignSource) source!: AdCampaignSource;
  @IsEnum(AdPlacement) placement!: AdPlacement;
  @IsString() adSlotId!: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string | null;
  @IsString() imageUrl!: string;
  @IsOptional() @IsString() ctaLabel?: string | null;
  @IsOptional() @IsString() ctaUrl?: string | null;
  @IsOptional() @IsString() targetCountry?: string | null;
  @IsOptional() @IsString() targetCity?: string | null;
  @IsOptional() @IsString() buildingId?: string | null;
}

export class UpdateAdminAdCampaignDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(AdCampaignSource) source?: AdCampaignSource;
  @IsOptional() @IsEnum(AdPlacement) placement?: AdPlacement;
  @IsOptional() @IsString() adSlotId?: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() ctaLabel?: string | null;
  @IsOptional() @IsString() ctaUrl?: string | null;
  @IsOptional() @IsString() targetCountry?: string | null;
  @IsOptional() @IsString() targetCity?: string | null;
  @IsOptional() @IsString() buildingId?: string | null;
}

export class ListAdminAdCampaignsDto {
  @ApiPropertyOptional({ enum: AdCampaignStatus })
  @IsOptional()
  @IsEnum(AdCampaignStatus)
  status?: AdCampaignStatus;
  @ApiPropertyOptional({ enum: AdCampaignSource })
  @IsOptional()
  @IsEnum(AdCampaignSource)
  source?: AdCampaignSource;
  @ApiPropertyOptional({ enum: AdPlacement })
  @IsOptional()
  @IsEnum(AdPlacement)
  placement?: AdPlacement;
  @IsOptional() @IsString() buildingId?: string;
  @IsOptional() @IsString() adSlotId?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() limit?: string;
}

export class ListAdminAdSlotsDto {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() zone?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

export class UpdateAdminAdSlotDto {
  @IsEnum(AdSlotFillStrategy) fillStrategy!: AdSlotFillStrategy;
  @IsEnum(AdExternalProvider) externalProvider!: AdExternalProvider;
  @IsOptional() @IsString() androidAdUnitId?: string | null;
  @IsOptional() @IsString() iosAdUnitId?: string | null;
}
