import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-113 — Financial Administration (Stage 6). Mandatory
 * `reason`, unlike the in-building Finance module's own `ReversePaymentDto`
 * (`reason` optional there) — per this engagement's own General
 * Principles, a staff-direct Force Action always carries a justification.
 * A structurally-compatible subtype of `ReversePaymentDto` (required
 * `reason` satisfies that DTO's own optional `reason?`), so it can be
 * passed directly to `FinanceService.reversePayment` without remapping.
 */
export class AdminReversePaymentDto {
  @ApiProperty({ description: 'Mandatory justification for reversing this payment.' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
