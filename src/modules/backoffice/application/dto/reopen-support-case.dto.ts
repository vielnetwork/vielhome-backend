import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** 07.05 Rule 011 — reopening a resolved/closed ticket requires stating why. */
export class ReopenSupportCaseDto {
  @ApiProperty()
  @IsString()
  @MinLength(5)
  reason!: string;
}
