import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * 10.07.03 — registers an existing Person as the unit's tenant. Unlike
 * `InviteOwnerDto`, this requires an existing `personId` rather than a
 * bare phone number — inviting a not-yet-registered tenant by phone
 * (mirroring `Unit.ownerPhone`'s auto-link pattern) is a reasonable
 * future fast-follow, the same way owner auto-linking itself was added
 * after the first pass (see `BuildingService.inviteOwner`'s own comment),
 * but is not built this sprint.
 */
export class CreateTenancyDto {
  @ApiProperty()
  @IsString()
  tenantPersonId!: string;
}
