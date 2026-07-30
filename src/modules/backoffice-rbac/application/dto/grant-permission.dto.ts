import { ApiProperty } from '@nestjs/swagger';
import type { PermissionKey } from '@prisma/client';
import { IsEnum } from 'class-validator';

const PERMISSION_KEYS = [
  'USER_VIEW',
  'USER_EDIT',
  'BUILDING_VIEW',
  'BUILDING_EDIT',
  'MARKETPLACE_REVIEW',
  'MARKETPLACE_APPROVE',
  'FINANCE_VIEW',
  'FINANCE_REFUND',
  'AUDIT_VIEW',
  'SYSTEM_SETTINGS',
  'FEATURE_FLAGS',
  'SUBSCRIPTION_VIEW',
  'SUBSCRIPTION_MANAGE',
] as const;

/** 21_ADRs > ADR-099 §6 — `POST /backoffice/rbac/roles/:roleId/permissions`. */
export class GrantPermissionDto {
  @ApiProperty({ enum: PERMISSION_KEYS })
  @IsEnum(PERMISSION_KEYS)
  permissionKey!: PermissionKey;
}
