import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/** 07.05 Rule 006 (internal note) / Rule 017-018 (communication history), unified into one threaded message. `isInternal` is ignored by the member-facing route — always forced to `false` in `SupportCaseService.replyAsCreator` regardless of what's sent. */
export class AddSupportCaseMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  body!: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}
