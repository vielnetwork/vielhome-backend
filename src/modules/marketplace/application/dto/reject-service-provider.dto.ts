import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * ADR-097 — Marketplace Review Workflow (Phase 2), requirement 4:
 * "Reject requires: rejectionReason." `POST /backoffice/marketplace-
 * providers/:id/reject` — unlike the pre-existing `DecideServiceProviderDto`
 * (still used by the unchanged `/decide` route, where `reason` stays
 * optional for backward compatibility), this dedicated reject endpoint
 * makes the reason mandatory at the validation layer.
 */
export class RejectServiceProviderDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  reason!: string;
}
