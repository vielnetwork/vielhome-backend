import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsString } from 'class-validator';

/**
 * 04.06 Rule 12 "Meeting Attendance Must Be Recorded" — bulk-records
 * attendance for a list of Persons in one call. Who is authorized to
 * record attendance is unspecified by the source rule; defaulted to the
 * same staff-facing roles that create/update the meeting itself (see
 * `MeetingController`'s guard on this route), the safer/more defensible
 * choice absent a named self-check-in flow.
 */
export class RecordAttendanceDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  personIds!: string[];
}
