import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /backoffice/notification-templates (21_ADRs > ADR-060). `code` is
 * the stable lookup key a future caller renders by — no format is
 * mandated by any source doc, so this only bounds length, not shape.
 */
export class CreateNotificationTemplateDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  code!: string;

  @ApiProperty()
  @IsString()
  titleTemplate!: string;

  @ApiProperty()
  @IsString()
  bodyTemplate!: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
