import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

/**
 * Returns cash to the payer on a valid, already-APPROVED payment (08.06
 * Rules 010/013/015 — see 21_ADRs > ADR-037). `amount` defaults to the
 * full original payment amount when omitted; a smaller value is a partial
 * refund (this MVP still only allows one refund per payment — see the
 * `Refund` model's own schema comment).
 */
export class RefundPaymentDto {
  @ApiProperty({ required: false, description: 'Defaults to the full original payment amount.' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  amount?: number;

  @ApiProperty()
  @IsString()
  reason!: string;
}
