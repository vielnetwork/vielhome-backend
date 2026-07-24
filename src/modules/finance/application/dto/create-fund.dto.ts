import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

const FUND_TYPES = [
  'CURRENT',
  'RESERVE',
  'EMERGENCY',
  'RENOVATION',
  'INSURANCE',
  'CUSTOM',
] as const;

const ACCOUNT_LINK_TYPES = ['BANK', 'CASH'] as const;

export class CreateFundDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: FUND_TYPES })
  @IsIn(FUND_TYPES)
  type!: (typeof FUND_TYPES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  /**
   * ADR-094 (Sprint 29) — a fund's starting balance is never written
   * directly to `Fund.balance`; `FinanceService.createFund` posts it as a
   * real `OPENING_BALANCE` LedgerEntry instead, keeping the Ledger the
   * actual source of truth (12_Finance_Architecture > "Ledger"). Omit or 0
   * for a fund that starts empty.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  initialBalance?: number;

  @ApiProperty({ required: false, enum: ACCOUNT_LINK_TYPES })
  @IsOptional()
  @IsIn(ACCOUNT_LINK_TYPES)
  accountLinkType?: (typeof ACCOUNT_LINK_TYPES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  accountReference?: string;
}
