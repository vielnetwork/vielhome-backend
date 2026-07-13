import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** 07.03 Rule 007/011: an investigation resolves to CONFIRM (fraud found) or DISMISS (false report / insufficient evidence). */
export class DecideFraudCaseDto {
  @ApiProperty({ enum: ['CONFIRM', 'DISMISS'] })
  @IsEnum(['CONFIRM', 'DISMISS'])
  decision!: 'CONFIRM' | 'DISMISS';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
