import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** ADR-030 — platform staff moderation decision. */
export class DecideServiceProviderDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsEnum(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
