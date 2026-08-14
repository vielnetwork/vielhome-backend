import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString } from 'class-validator';

/**
 * Finance Correction Pass — corrects a unit's *effective opening balance*
 * (its initial debt/credit as of "now", independent of any regular
 * ChargeBatch/Payment activity since). There is no dedicated opening-balance
 * field on `Unit` — see `FinanceService.correctOpeningBalance`'s own doc
 * comment for how "effective opening balance" is defined and why this is
 * layered on the existing Adjustment/Ledger mechanism unchanged.
 */
export class CorrectOpeningBalanceDto {
  @ApiProperty({
    description:
      'The unit\'s new effective opening balance. Positive = debt owed, negative = credit, zero = settled.',
  })
  @IsInt()
  targetBalance!: number;

  @ApiProperty({ description: 'Why this correction is being made.' })
  @IsString()
  reason!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fundId?: string;
}
