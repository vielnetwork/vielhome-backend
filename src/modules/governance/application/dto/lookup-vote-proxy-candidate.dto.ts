import { ApiProperty } from '@nestjs/swagger';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * Standing Proxy Voting — Members Lookup Hardening (21_ADRs > ADR-089,
 * Phase 4B). Replaces the removed generic `BuildingController`
 * `GET :id/members/lookup` route, which let any current member of any
 * role resolve any other member's identity building-wide by phone. This
 * DTO backs a purpose-specific, unit-scoped replacement instead:
 * `POST :id/units/:unitId/vote-proxy/lookup`, reachable only by the
 * unit's own live eligible voter (see `VoteProxyService
 * .lookupCandidateByPhone`). Bound via a whole-object `@Body()`
 * parameter so the global `ValidationPipe` (`transform: true`)
 * normalizes/validates `phone` exactly like every other phone-bearing
 * DTO in this API (`IsIranianMobilePhone` — Persian/Arabic-indic digits,
 * local `09...` form, all normalized to canonical `+989...`).
 */
export class LookupVoteProxyCandidateDto {
  @ApiProperty({ example: '+989121234567' })
  @IsIranianMobilePhone()
  phone!: string;
}
