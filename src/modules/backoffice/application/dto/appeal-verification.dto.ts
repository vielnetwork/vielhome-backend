import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** 07.01 Rule 014/015, 07.02 Rule 012/013 — an appeal creates a new, independent review case; the previous decision is preserved, never deleted. */
export class AppealVerificationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
