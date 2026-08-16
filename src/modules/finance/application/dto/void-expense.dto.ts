import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Corrects a posted Expense by voiding it (FIN-EXP-01/FIN-EXP-02 — see
 * 21_ADRs > ADR-126). Expense is immutable after creation — there is no
 * edit endpoint; a mistaken Expense is voided (with a mandatory reason)
 * and a fresh, correct Expense is created in its place, exactly like
 * `reversePayment`'s correction pattern. `voidReason` is required, unlike
 * `ReversePaymentDto.reason` (optional) — Expense void has no upstream
 * gateway/bank-driven trigger the way a bounced payment does, so the
 * human reason is the only record of why, making it required here.
 */
export class VoidExpenseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  voidReason!: string;
}
