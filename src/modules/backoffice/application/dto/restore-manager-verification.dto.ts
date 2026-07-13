import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** 21_ADRs > ADR-040 — restores a SUSPENDED manager verification back to VERIFIED. No `decision` field (unlike `DecideManagerVerificationDto`) since Restore is the only decision this endpoint can produce. */
export class RestoreManagerVerificationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
