import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-114 — Notification Administration (Stage 7). `reason` is
 * mandatory, same rationale as `LockBuildingDto`/`AdminReversePaymentDto`
 * — Resend is one of this engagement's own General Principles' "sensitive
 * operation" action types requiring a staff-supplied reason.
 */
export class ResendNotificationDeliveryDto {
  @ApiProperty({
    description: 'Mandatory justification for resending this FAILED notification delivery.',
  })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
