import { ApiProperty } from '@nestjs/swagger';
import { AchievementCode } from '@prisma/client';
import { IsEnum, IsString, MinLength } from 'class-validator';

/**
 * 21_ADRs > ADR-124 — Backoffice manual achievement revoke. `personId` is
 * a path param. Same `code`/`reason` shape as `GrantAchievementDto` (no
 * `buildingId` — revocation targets the currently-active `PersonAchievement`
 * row for this person+code, whichever building it was originally granted
 * under; see `GamificationRepository.revokeAchievement`).
 */
export class RevokeAchievementDto {
  @ApiProperty({ enum: AchievementCode })
  @IsEnum(AchievementCode)
  code!: AchievementCode;

  @ApiProperty({ description: 'Mandatory justification for this revocation.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}
