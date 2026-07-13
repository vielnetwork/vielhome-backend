import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsPhoneNumber, IsOptional } from 'class-validator';
import { OtpPurpose } from '@prisma/client';

export class RequestOtpDto {
  @ApiProperty({ example: '+989121234567' })
  @IsPhoneNumber(undefined)
  phone!: string;

  @ApiProperty({ enum: ['LOGIN', 'REGISTER', 'VERIFY_PHONE'], default: 'LOGIN' })
  @IsOptional()
  @IsIn(['LOGIN', 'REGISTER', 'VERIFY_PHONE'])
  purpose: OtpPurpose = 'LOGIN';
}
