import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * 08.07 Rule 011/012 (see 21_ADRs > ADR-089) — appoints an existing
 * current member of the same building as the unit's standing proxy.
 */
export class GrantVoteProxyDto {
  @ApiProperty()
  @IsString()
  proxyPersonId!: string;
}
