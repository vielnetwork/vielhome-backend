import { ApiProperty } from '@nestjs/swagger';
import { IsPhoneNumber } from 'class-validator';

/**
 * 10.07.02 — the current owner initiates a transfer by the incoming
 * owner's phone number, reusing the exact same field/mechanism as
 * `InviteOwnerDto` and the auto-link-on-OTP-verify flow it already
 * triggers (see `BuildingRepository.transferOwnership`'s own comment).
 */
export class TransferOwnershipDto {
  @ApiProperty({ example: '+989121234567' })
  @IsPhoneNumber(undefined)
  newOwnerPhone!: string;
}
