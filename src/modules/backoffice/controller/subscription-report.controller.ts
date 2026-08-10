import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SubscriptionService } from '../application/subscription.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import {
  EffectiveFeaturesEnvelopeDto,
  SubscriptionDetailEnvelopeDto,
} from '../application/dto/subscription-read.dto';

/**
 * Member-facing, read-only view of a building's own subscription (07.04/
 * 04.04 — see 21_ADRs > ADR-033). `MembershipGuard` (any current member,
 * not a specific role) — same guard `VotingController` uses for its own
 * read routes — since seeing what your building's plan unlocks is not a
 * privileged action the way changing it is.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class SubscriptionReportController {
  constructor(private readonly service: SubscriptionService) {}

  @Get(':id/subscription')
  @UseGuards(MembershipGuard)
  @ApiOkResponse({ type: SubscriptionDetailEnvelopeDto })
  get(@Param('id') id: string) {
    return this.service.getReadDetail(id);
  }

  @Get(':id/subscription/effective-features')
  @UseGuards(MembershipGuard)
  @ApiOkResponse({ type: EffectiveFeaturesEnvelopeDto })
  effectiveFeatures(@Param('id') id: string) {
    return this.service.resolveEffectiveFeatures(id);
  }
}
