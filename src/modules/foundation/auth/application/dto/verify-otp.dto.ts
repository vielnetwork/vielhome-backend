import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsPhoneNumber, IsString, Length } from 'class-validator';
import { OtpPurpose } from '@prisma/client';

export class VerifyOtpDto {
  @ApiProperty({ example: '+989121234567' })
  @IsPhoneNumber(undefined)
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
