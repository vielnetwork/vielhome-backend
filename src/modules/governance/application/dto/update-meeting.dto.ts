import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Updates a Meeting's basic details, and/or records its minutes (04.06
 * Rule 13 "Meeting Minutes Must Be Preserved" — minutes are attached via
 * this same update action, there being no separate "minutes" endpoint
 * named anywhere in the source rules). Blocked once the meeting is
 * archived — see `MeetingPolicy.assertNotArchived`.
 */
export class UpdateMeetingDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  minutes?: string;
}
