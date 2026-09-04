import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RevokePushTokenDto {
  @ApiProperty({ description: "The caller's stable per-install device token." })
  @IsString()
  @IsNotEmpty()
  deviceToken!: string;
}
