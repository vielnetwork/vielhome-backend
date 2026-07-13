import { ApiProperty } from '@nestjs/swagger';
import type { FeatureGrantType, SubscriptionFeatureKey } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

const FEATURE_KEYS = [
  'BUILDING_REGISTRATION', 'PROPERTIES', 'OWNERS', 'TENANTS', 'BASIC_CHARGES', 'BASIC_PAYMENTS',
  'DEBT_VIEW', 'IN_APP_NOTIFICATIONS', 'ONLINE_PAYMENT', 'DOCUMENTS', 'VOTING', 'MEETINGS',
  'REQUESTS', 'REPORTS', 'FUNDS', 'ADVANCED_ACCOUNTING', 'SMS', 'EMAIL', 'PUSH_NOTIFICATIONS', 'AUTOMATION',
];
const GRANT_TYPES = ['PROMOTION', 'SUPPORT', 'PARTNERSHIP', 'TRIAL_EXTENSION', 'BETA_TESTING', 'OTHER'];

/** 07.04 Rule 008/009/017 — grants a feature outside the plan, optionally time-boxed (`expiresAt` omitted = permanent until revoked). */
export class CreateFeatureGrantDto {
  @ApiProperty({ enum: FEATURE_KEYS })
  @IsEnum(FEATURE_KEYS)
  featureKey!: SubscriptionFeatureKey;

  @ApiProperty({ enum: GRANT_TYPES })
  @IsEnum(GRANT_TYPES)
  grantType!: FeatureGrantType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({ required: false, description: 'ISO date string; omit for a permanent grant' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
