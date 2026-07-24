import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { OtpPurpose } from '@prisma/client';
import { IsIranianMobilePhone } from '../../../../../common/decorators/is-iranian-mobile-phone.decorator';

export class RequestOtpDto {
  /**
   * Phone Number Input & Normalization task — accepts 09..., 9...,
   * 989..., +989..., and Persian/Arabic-Indic digit equivalents of any of
   * those; normalized to +989XXXXXXXXX before this ever reaches the
   * service (see IsIranianMobilePhone). Replaces the old region-agnostic
   * `@IsPhoneNumber(undefined)`, which only ever accepted E.164.
   */
  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  phone!: string;

  @ApiProperty({ enum: ['LOGIN', 'REGISTER', 'VERIFY_PHONE'], default: 'LOGIN' })
  @IsOptional()
  @IsIn(['LOGIN', 'REGISTER', 'VERIFY_PHONE'])
  purpose: OtpPurpose = 'LOGIN';
}
