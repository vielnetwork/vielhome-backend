import { ApiProperty } from '@nestjs/swagger';
import type { ManagerVerificationDecision } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** 07.02 Rule 008: reviewer can APPROVE / REJECT / SUSPEND. */
export class DecideManagerVerificationDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT', 'SUSPEND'] })
  @IsEnum(['APPROVE', 'REJECT', 'SUSPEND'])
  decision!: ManagerVerificationDecision;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
