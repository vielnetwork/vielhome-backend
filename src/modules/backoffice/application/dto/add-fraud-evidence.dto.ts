import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** 07.03 Rule 005 — free-text Evidence Aggregation notes, appended while UNDER_INVESTIGATION. */
export class AddFraudEvidenceDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  evidenceNotes!: string;
}
