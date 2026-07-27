import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * Building Setup Refinement Phase 3 — additive sibling of `InviteOwnerDto`.
 * `POST :id/units/:unitId/invite-owner` + `InviteOwnerDto.ownerFullName` is
 * part of the frozen v1.0 API contract and stays completely untouched (any
 * existing caller keeps working exactly as before). This DTO backs the NEW
 * `POST :id/units/:unitId/invite-owner/v2` route: separate first/last name,
 * per the product decision that Owner identity must be stored as discrete
 * fields, not a combined Full Name string, the same way Tenant registration
 * now works. Stored on `Unit.ownerFirstName`/`ownerLastName` — the exact
 * same "pending invite, no Person row yet" mechanism `ownerFullName`/
 * `ownerPhone` already used, just split into two fields.
 */
export class InviteOwnerV2Dto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  ownerFirstName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  ownerLastName!: string;

  /** Phone Number Input & Normalization task — see RequestOtpDto.phone's own comment. */
  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  ownerPhone!: string;
}
