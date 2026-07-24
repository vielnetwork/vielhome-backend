import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const FUND_TYPES = [
  'CURRENT',
  'RESERVE',
  'EMERGENCY',
  'RENOVATION',
  'INSURANCE',
  'CUSTOM',
] as const;

const ACCOUNT_LINK_TYPES = ['BANK', 'CASH'] as const;

/**
 * ADR-094 (Sprint 29) — deliberately excludes `balance`/`isActive`.
 * Balance only ever moves through a real LedgerEntry (never a direct
 * field edit — 12_Finance_Architecture's immutable-ledger philosophy);
 * `isActive` has its own dedicated deactivate/reactivate endpoints so
 * that action gets its own audit-log entry rather than being buried in a
 * general-purpose PATCH.
 */
export class UpdateFundDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, enum: FUND_TYPES })
  @IsOptional()
  @IsIn(FUND_TYPES)
  type?: (typeof FUND_TYPES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, enum: ACCOUNT_LINK_TYPES })
  @IsOptional()
  @IsIn(ACCOUNT_LINK_TYPES)
  accountLinkType?: (typeof ACCOUNT_LINK_TYPES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  accountReference?: string;
}
