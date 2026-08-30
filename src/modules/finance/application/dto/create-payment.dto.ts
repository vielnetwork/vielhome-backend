import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER'] as const;

/**
 * FIN-MVP-GAP-04C — the controlled Manual / On-Behalf Payment contract.
 * Restricted to a building's MANAGER/ACCOUNTANT (route-level `RolesGuard`
 * — see `FinanceController.createPayment`); resident self-service lives
 * on the separate explicit-obligations flow (`CreateExplicitPaymentDto`),
 * unchanged by this DTO. It starts PENDING_APPROVAL — no cash gateway
 * exists at MVP (05_Business_Rules / 12_Finance_Architecture: Cash + Bank
 * Transfer only), so every payment must still be confirmed by an
 * ACCOUNTANT or MANAGER before it touches the ledger (see
 * `FinanceService.approvePayment`). `unitId` is a path param, not part of
 * this body.
 *
 * The reporting staff member (`actorPersonId`, from the JWT) is never the
 * payer — see `payerPersonId` below and `FinanceService.createPayment`'s
 * own doc comment for the full on-behalf semantics this closes.
 */
export class CreatePaymentDto {
  /**
   * FIN-MVP-GAP-04C — the person this Payment economically belongs to.
   * Required; never inferred from the caller. `FinanceService.
   * createPayment` validates this against the unit's current
   * responsible-payer set (its active tenant if one exists, else one of
   * its current owners — see `assertValidPayerForUnit`'s own doc
   * comment) before it is ever written to `Payment.payerId`. A Manager/
   * Accountant may name themselves here only if they independently
   * qualify as that tenant or one of those owners.
   */
  @ApiProperty({
    description:
      "The person this Payment economically belongs to — must be the unit's " +
      'current tenant, or one of its current owners when there is no active ' +
      'tenancy. Never the reporting staff member unless they independently ' +
      'qualify.',
  })
  @IsString()
  @IsNotEmpty()
  payerPersonId!: string;

  /**
   * FIN-MVP-GAP-04C — required, mirroring `CreateExplicitPaymentDto
   * .idempotencyKey`'s existing contract exactly (same
   * `(payerId, buildingId, idempotencyKey)` uniqueness, same replay-safe
   * guarantee — see `FinanceRepository.createPayment`'s own doc comment).
   */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

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
