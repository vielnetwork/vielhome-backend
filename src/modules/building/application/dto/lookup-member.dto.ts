import { ApiProperty } from '@nestjs/swagger';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * Phone Number Input & Normalization task — `GET :id/members/lookup`
 * (21_ADRs > ADR-092) previously read `phone` as a raw, unvalidated
 * `@Query('phone') phone: string`, which meant a malformed or non-ASCII-
 * digit phone silently produced "no such member" instead of a real 400 —
 * the worst kind of gap, since it looks like a normal not-found result.
 * This DTO closes that: bound via a whole-object `@Query()` parameter so
 * the global `ValidationPipe` (`transform: true`) normalizes/validates it
 * exactly like every other phone-bearing DTO in this API.
 */
export class LookupMemberQueryDto {
  @ApiProperty({ example: '+989121234567' })
  @IsIranianMobilePhone()
  phone!: string;
}
