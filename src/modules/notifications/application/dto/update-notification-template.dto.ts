import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** PATCH /backoffice/notification-templates/:id — `code` is immutable (the stable lookup key); only copy/state can change. */
export class UpdateNotificationTemplateDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  titleTemplate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bodyTemplate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
