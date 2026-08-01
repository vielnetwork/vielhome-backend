import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MinLength } from 'class-validator';

/** 21_ADRs > ADR-109 — `key` is deliberately constrained to
 * SCREAMING_SNAKE_CASE, the conventional shape for a code-referenced
 * constant, so a flag key reads unambiguously as an identifier
 * (`NEW_DASHBOARD_ENABLED`) rather than free text. `reason` is mandatory
 * — creating a flag is a mutating, auditable action like any other. */
export class CreateFeatureFlagDto {
  @ApiProperty({ example: 'NEW_DASHBOARD_ENABLED' })
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message:
      'key must be SCREAMING_SNAKE_CASE, starting with a letter (e.g. NEW_DASHBOARD_ENABLED).',
  })
  key!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Defaults to false (safe default: new flags start disabled).',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ description: 'Why this flag is being created. Always required.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}
