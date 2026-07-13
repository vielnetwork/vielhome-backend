import { ApiProperty } from '@nestjs/swagger';
import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

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

  @ApiProperty({ example: '+989121234567' })
  @IsPhoneNumber(undefined)
  ownerPhone!: string;
}
