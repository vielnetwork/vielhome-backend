import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER'] as const;

/**
 * A resident (or a manager/accountant recording cash collected in person)
 * reports a payment against a unit. It starts PENDING_APPROVAL — no cash
 * gateway exists at MVP (05_Business_Rules / 12_Finance_Architecture: Cash
 * + Bank Transfer only), so every payment is self-reported and must be
 * confirmed by an ACCOUNTANT or MANAGER before it touches the ledger (see
 * FinanceService.approvePayment). `unitId` is a path param, not part of
 * this body.
 */
export class CreatePaymentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fundId?: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: (typeof PAYMENT_METHODS)[number];

  @ApiProperty({ required: false, description: 'Bank reference number / receipt number, if any.' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string;
}
