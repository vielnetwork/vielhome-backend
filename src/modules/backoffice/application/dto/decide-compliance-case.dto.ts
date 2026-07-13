import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** 07.06 Rule 012: an investigation resolves to CONFIRM (a real compliance issue) or DISMISS (false positive / insufficient evidence). */
export class DecideComplianceCaseDto {
  @ApiProperty({ enum: ['CONFIRM', 'DISMISS'] })
  @IsEnum(['CONFIRM', 'DISMISS'])
  decision!: 'CONFIRM' | 'DISMISS';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
