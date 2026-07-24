import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * "Invite owner" — per the product decision, name + phone are the two
 * mandatory fields to send an invite (no SMS gateway yet, console-logged
 * like OTP; see BuildingService.inviteOwner for what's NOT built yet).
 */
export class InviteOwnerDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  ownerFullName!: string;

  /** Phone Number Input & Normalization task — see RequestOtpDto.phone's own comment. */
  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  ownerPhone!: string;
}
