import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** 07.03 Rule 019 — a Senior Reviewer either UPHOLDs the original action or OVERTURNs it. */
export class DecideEnforcementAppealDto {
  @ApiProperty({ enum: ['UPHOLD', 'OVERTURN'] })
  @IsEnum(['UPHOLD', 'OVERTURN'])
  decision!: 'UPHOLD' | 'OVERTURN';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
