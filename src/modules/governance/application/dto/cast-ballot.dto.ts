import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * A ballot is cast on behalf of a Unit ("One Property One Vote," 04.06
 * Rule 2), not the caller as a person — `unitId` is therefore part of the
 * body, and `VotingService.castBallot` verifies the caller is that unit's
 * sole eligible owner (per the vote's eligibility snapshot) before
 * accepting it.
 */
export class CastBallotDto {
  @ApiProperty()
  @IsString()
  unitId!: string;

  @ApiProperty()
  @IsString()
  selectedOptionId!: string;
}
