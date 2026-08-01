import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/** 21_ADRs > ADR-109 — `key` is immutable once created (no rename route
 * in Phase 1 — anything referencing the old key by name would silently
 * break). At least one of `enabled`/`description` must be present; the
 * service layer enforces that (see `FeatureFlagService.update`), since
 * class-validator's `@IsOptional()` on both cannot express "at least one
 * of these two." `reason` is always required. */
export class UpdateFeatureFlagDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Why this change is being made. Always required.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}
