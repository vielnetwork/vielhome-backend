import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MinLength } from 'class-validator';

/** 21_ADRs > ADR-116 — `reason` is mandatory on every provider-setting
 * change (enabling AND disabling), matching this codebase's "reason
 * required for sensitive/mutating actions" convention — same shape as
 * `ToggleMaintenanceModeDto` (ADR-109). */
export class ToggleProviderSettingDto {
  @ApiProperty({ description: 'true to enable this provider, false to disable it.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ description: 'Why this change is being made. Always required.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}
