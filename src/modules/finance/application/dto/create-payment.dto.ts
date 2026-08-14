import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

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

  /** Finance Hardening Pass / ADR-125 — whole Iranian Rial (IRR), passed unchanged to `Payment.amount`; fractional values are invalid. */
  @ApiProperty()
  @IsInt()
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

  /**
   * Finance QA correction (physical-device duplicate-payment bug, 2026-08)
   * — explicit contract for "this amount was deliberately chosen by the
   * reporter," not auto-filled from the unit's current remaining payable.
   * Defaults to `false`. When `false`, `FinanceService.createPayment`
   * rejects an `amount` greater than the unit's current `remainingPayable`
   * (`FinanceRepository.computeDebtSnapshot`'s own doc comment) — closing
   * the bug where repeated taps on an auto-filled amount created multiple
   * PENDING_APPROVAL payments for the same debt. When `true`, that ceiling
   * is bypassed — a manual entry may legitimately exceed remaining payable
   * (a partial payment, a deliberate overpayment that becomes
   * `CreditBalance`, or a voluntary payment while remaining payable is
   * already zero — Mobile's "I'll enter the amount myself" checkbox and
   * its zero-debt/credit confirmation "Yes" both set this to `true`).
   * Never inferred from the amount itself — always this explicit flag.
   */
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isManualAmount?: boolean;
}
