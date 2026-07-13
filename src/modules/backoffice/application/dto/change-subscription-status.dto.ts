import { ApiProperty } from '@nestjs/swagger';
import type { SubscriptionStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

const STATUSES = ['TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED'];

/** 07.04 Rule 011 — staff may set a subscription's status directly (standing in for real billing-driven transitions). */
export class ChangeSubscriptionStatusDto {
  @ApiProperty({ enum: STATUSES })
  @IsEnum(STATUSES)
  status!: SubscriptionStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
