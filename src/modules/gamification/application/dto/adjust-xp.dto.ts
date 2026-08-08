import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MinLength, NotEquals } from 'class-validator';

/**
 * 21_ADRs > ADR-124 — Backoffice manual XP correction. `personId` is a
 * path param, not part of this body — same shape as `CreateAdjustmentDto`
 * (`unitId` as a path param) and `AdminReversePaymentDto` (`paymentId` as
 * a path param). `amount` follows `CreateAdjustmentDto`'s own
 * `@IsInt() @NotEquals(0)` precedent — signed, nonzero (a zero-value
 * correction does nothing and would produce a misleading audit record and
 * ledger row for no actual change). `reason` is mandatory, matching this
 * codebase's own "a staff-direct Force Action always carries a
 * justification" principle (`AdminReversePaymentDto`), with a minimum
 * length so a one-character placeholder can't satisfy it (matching
 * `ToggleProviderSettingDto.reason`'s own `@MinLength(3)`).
 */
export class AdjustXpDto {
  @ApiProperty({ description: 'Signed XP delta. Positive adds, negative subtracts. Cannot be zero.' })
  @IsInt()
  @NotEquals(0)
  amount!: number;

  @ApiProperty({ description: 'Mandatory justification for this correction.' })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiProperty({
    required: false,
    description: 'Optional building context for this correction (e.g. for audit scoping).',
  })
  @IsOptional()
  @IsString()
  buildingId?: string;
}
