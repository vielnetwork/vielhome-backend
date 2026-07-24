import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import { OtpPurpose } from '@prisma/client';
import { IsIranianMobilePhone } from '../../../../../common/decorators/is-iranian-mobile-phone.decorator';

export class VerifyOtpDto {
  /** Phone Number Input & Normalization task — see RequestOtpDto.phone's own comment. */
  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  phone!: string;

  @ApiProperty({ example: '12345' })
  @IsString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ enum: ['LOGIN', 'REGISTER', 'VERIFY_PHONE'], default: 'LOGIN' })
  @IsOptional()
  @IsIn(['LOGIN', 'REGISTER', 'VERIFY_PHONE'])
  purpose: OtpPurpose = 'LOGIN';

  @ApiProperty({
    example: 'device-abc-123',
    description: 'Stable per-install device token (Remember Device).',
  })
  @IsString()
  @IsNotEmpty()
  deviceToken!: string;

  @ApiProperty({ enum: ['ios', 'android', 'web'] })
  @IsIn(['ios', 'android', 'web'])
  platform!: 'ios' | 'android' | 'web';
}
