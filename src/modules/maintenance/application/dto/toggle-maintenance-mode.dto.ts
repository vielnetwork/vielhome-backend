import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/** 21_ADRs > ADR-109 — `reason` is mandatory on every maintenance-mode
 * change (enabling AND disabling), matching this codebase's "reason
 * required for sensitive/mutating actions" convention. `message` is an
 * optional customer-facing note (e.g. an ETA) — never required. */
export class ToggleMaintenanceModeDto {
  @ApiProperty({ description: 'true to enable global maintenance mode, false to disable it.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ description: 'Why this change is being made. Always required.' })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Optional customer-facing message shown while maintenance mode is enabled.',
  })
  @IsOptional()
  @IsString()
  message?: string;
}
