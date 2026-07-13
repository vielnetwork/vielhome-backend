import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** PATCH /notification-preferences (08.10's "Update Preferences" endpoint) — every field optional, only what's provided changes. */
export class UpdatePreferenceDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @ApiProperty({ required: false, description: '13_Notification_Architecture: Marketing is opt-in only.' })
  @IsOptional()
  @IsBoolean()
  marketingEnabled?: boolean;
}
