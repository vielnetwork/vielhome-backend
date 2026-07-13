import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class AddMessageDto {
  @ApiProperty()
  @IsString()
  message!: string;

  @ApiProperty({ required: false, default: false, description: 'Only a privileged role (MANAGER/BOARD_MEMBER/ACCOUNTANT) may set this.' })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}
