import { ApiProperty } from '@nestjs/swagger';
import {
  FeatureGrantType,
  SubscriptionFeatureKey,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';

const FEATURE_RESULTS = ['ALLOWED', 'DENIED'] as const;
const FEATURE_SOURCES = ['PLAN', 'GRANT'] as const;

export class SubscriptionFeatureGrantReadDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  subscriptionId!: string;

  @ApiProperty({ enum: SubscriptionFeatureKey })
  featureKey!: SubscriptionFeatureKey;

  @ApiProperty({ enum: FeatureGrantType })
  grantType!: FeatureGrantType;

  @ApiProperty({ nullable: true })
  reason!: string | null;

  @ApiProperty()
  grantedById!: string;

  @ApiProperty({ format: 'date-time' })
  grantedAt!: Date;

  @ApiProperty({ nullable: true, format: 'date-time' })
  expiresAt!: Date | null;

  @ApiProperty({ nullable: true })
  revokedById!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  revokedAt!: Date | null;
}

export class SubscriptionDetailDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  buildingId!: string;

  @ApiProperty({ enum: SubscriptionPlan })
  plan!: SubscriptionPlan;

  @ApiProperty({ enum: SubscriptionStatus })
  status!: SubscriptionStatus;

  @ApiProperty({ nullable: true, format: 'date-time' })
  trialEndsAt!: Date | null;

  @ApiProperty()
  trialUsed!: boolean;

  @ApiProperty()
  gracePeriodDays!: number;

  @ApiProperty({ nullable: true, format: 'date-time' })
  currentPeriodEndsAt!: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  gracePeriodEndsAt!: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  cancelledAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: SubscriptionFeatureGrantReadDto, isArray: true })
  featureGrants!: SubscriptionFeatureGrantReadDto[];
}

export class EffectiveFeatureDto {
  @ApiProperty({ enum: SubscriptionFeatureKey })
  featureKey!: SubscriptionFeatureKey;

  @ApiProperty({ enum: FEATURE_RESULTS })
  result!: (typeof FEATURE_RESULTS)[number];

  @ApiProperty({ enum: FEATURE_SOURCES })
  source!: (typeof FEATURE_SOURCES)[number];
}

export class EffectiveFeaturesDto {
  @ApiProperty({ enum: SubscriptionPlan })
  plan!: SubscriptionPlan;

  @ApiProperty({ enum: SubscriptionStatus })
  status!: SubscriptionStatus;

  @ApiProperty({ type: EffectiveFeatureDto, isArray: true })
  features!: EffectiveFeatureDto[];
}

export class SubscriptionHistoryEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  subscriptionId!: string;

  @ApiProperty({ nullable: true, enum: SubscriptionPlan })
  fromPlan!: SubscriptionPlan | null;

  @ApiProperty({ nullable: true, enum: SubscriptionPlan })
  toPlan!: SubscriptionPlan | null;

  @ApiProperty({ nullable: true, enum: SubscriptionStatus })
  fromStatus!: SubscriptionStatus | null;

  @ApiProperty({ nullable: true, enum: SubscriptionStatus })
  toStatus!: SubscriptionStatus | null;

  @ApiProperty({ nullable: true })
  changedById!: string | null;

  @ApiProperty({ nullable: true })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class SubscriptionDetailEnvelopeDto {
  @ApiProperty({ type: SubscriptionDetailDto })
  data!: SubscriptionDetailDto;
}

export class EffectiveFeaturesEnvelopeDto {
  @ApiProperty({ type: EffectiveFeaturesDto })
  data!: EffectiveFeaturesDto;
}

export class SubscriptionHistoryEnvelopeDto {
  @ApiProperty({ type: SubscriptionHistoryEntryDto, isArray: true })
  data!: SubscriptionHistoryEntryDto[];
}
