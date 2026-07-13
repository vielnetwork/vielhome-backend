import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Creates a Meeting (04.06 Rule 11 "Meetings Are Separate From Voting" —
 * see 21_ADRs > ADR-049). Deliberately no meeting-type/status field —
 * neither is named anywhere in the source rules.
 */
export class CreateMeetingDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty()
  @IsDateString()
  scheduledAt!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  location?: string;
}
