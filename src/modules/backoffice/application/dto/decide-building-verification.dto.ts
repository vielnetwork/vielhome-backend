import { ApiProperty } from '@nestjs/swagger';
import type { BuildingVerificationDecision } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

/** 07.01 Rule 006: manual review supports APPROVE / REJECT / REQUEST_INFORMATION. */
export class DecideBuildingVerificationDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT', 'REQUEST_INFORMATION'] })
  @IsEnum(['APPROVE', 'REJECT', 'REQUEST_INFORMATION'])
  decision!: BuildingVerificationDecision;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
