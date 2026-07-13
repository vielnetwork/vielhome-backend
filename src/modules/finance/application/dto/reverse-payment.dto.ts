import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** Undoes an erroneous/bounced/fraudulent APPROVED payment (08.06 Rule 010/014 — see 21_ADRs > ADR-037). */
export class ReversePaymentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
