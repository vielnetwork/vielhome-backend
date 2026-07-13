import { ApiProperty } from '@nestjs/swagger';
import type { SubscriptionPlan } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

const PLANS = ['FREE', 'PRO', 'ENTERPRISE'];

/** 07.04 Rule 011/014 — staff may change a building's plan at any time. */
export class ChangeSubscriptionPlanDto {
  @ApiProperty({ enum: PLANS })
  @IsEnum(PLANS)
  plan!: SubscriptionPlan;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
