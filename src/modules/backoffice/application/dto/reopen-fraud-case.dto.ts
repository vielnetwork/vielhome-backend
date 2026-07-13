import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** 07.03 Rule 016 — reopening a closed case requires new evidence to be stated. */
export class ReopenFraudCaseDto {
  @ApiProperty()
  @IsString()
  @MinLength(10)
  newEvidence!: string;
}
