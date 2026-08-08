import { ApiProperty } from '@nestjs/swagger';
import { AchievementCode } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * 21_ADRs > ADR-124 — Backoffice manual achievement grant. `personId` is a
 * path param. `code` validated directly against the real Prisma
 * `AchievementCode` enum via `@IsEnum` (kept automatically in sync with
 * the schema, unlike `GrantPermissionDto`'s own separately-maintained
 * `PERMISSION_KEYS` const array — no equivalent hand-duplicated list
 * exists for this DTO). `reason` mandatory, same `@MinLength(3)`
 * precedent as `AdjustXpDto`/`AdjustBuildingScoreDto`.
 */
export class GrantAchievementDto {
  @ApiProperty({ enum: AchievementCode })
  @IsEnum(AchievementCode)
  code!: AchievementCode;

  @ApiProperty({ description: 'Mandatory justification for this manual grant.' })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiProperty({ required: false, description: 'Optional building context for this grant.' })
  @IsOptional()
  @IsString()
  buildingId?: string;
}
