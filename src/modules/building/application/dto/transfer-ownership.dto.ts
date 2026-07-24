import { ApiProperty } from '@nestjs/swagger';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * 10.07.02 — the current owner initiates a transfer by the incoming
 * owner's phone number, reusing the exact same field/mechanism as
 * `InviteOwnerDto` and the auto-link-on-OTP-verify flow it already
 * triggers (see `BuildingRepository.transferOwnership`'s own comment).
 *
 * Phone Number Input & Normalization task — see RequestOtpDto.phone's own comment.
 */
export class TransferOwnershipDto {
  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  newOwnerPhone!: string;
}
