import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MinLength, NotEquals } from 'class-validator';

/**
 * 21_ADRs > ADR-124 — Backoffice manual Building Score correction.
 * `buildingId` is a path param, not part of this body. `delta` mirrors
 * `AdjustXpDto.amount` — signed, nonzero via `@IsInt() @NotEquals(0)`.
 * `reason` mandatory, same `@MinLength(3)` precedent as `AdjustXpDto`.
 */
export class AdjustBuildingScoreDto {
  @ApiProperty({
    description: 'Signed Building Score delta. Positive adds, negative subtracts. Cannot be zero.',
  })
  @IsInt()
  @NotEquals(0)
  delta!: number;

  @ApiProperty({ description: 'Mandatory justification for this correction.' })
  @IsString()
  @MinLength(3)
  reason!: string;
}
