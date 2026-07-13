import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** 07.03 Rule 019 — the enforcement action's target Person appeals it. */
export class AppealEnforcementDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
