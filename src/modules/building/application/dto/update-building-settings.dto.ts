import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * 21_ADRs > ADR-089 — Building Settings/Policy domain. Starts with one
 * field; `IsOptional` on it (rather than required) so a future second
 * toggle can be patched independently without this DTO needing every
 * field on every request.
 */
export class UpdateBuildingSettingsDto {
  @ApiPropertyOptional({
    description: "04.06 Rule 4 — allow a unit's current tenant to vote in place of its owner.",
  })
  @IsOptional()
  @IsBoolean()
  allowTenantVoting?: boolean;
}
