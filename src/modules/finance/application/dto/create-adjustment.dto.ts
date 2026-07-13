import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, NotEquals } from 'class-validator';

/**
 * A manual, signed correction to a unit's debt (08.05 Rule 014 — see
 * 21_ADRs > ADR-037). Negative waives existing outstanding debt; positive
 * adds new debt not tied to any ChargeBatch (e.g. a late fee). `unitId` is
 * a path param, not part of this body.
 */
export class CreateAdjustmentDto {
  @ApiProperty({ description: 'Negative waives debt, positive adds debt. Cannot be zero.' })
  @IsInt()
  @NotEquals(0)
  amount!: number;

  @ApiProperty()
  @IsString()
  reason!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fundId?: string;
}
