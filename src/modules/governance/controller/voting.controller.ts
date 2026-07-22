import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { VoteCategory, VoteStatus } from '@prisma/client';
import { VotingService } from '../application/voting.service';
import { VoteProxyService } from '../application/vote-proxy.service';
import { CreateVoteDto } from '../application/dto/create-vote.dto';
import { CastBallotDto } from '../application/dto/cast-ballot.dto';
import { CancelVoteDto } from '../application/dto/cancel-vote.dto';
import { GrantVoteProxyDto } from '../application/dto/grant-vote-proxy.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { VerifiedRolesGuard } from '../../../common/guards/verified-roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Governance / Voting (04.06_Governance_Rules, 06.06_Voting_Flow,
 * 08.07_Voting_API — see 21_ADRs > ADR-024). Shares the `buildings` base
 * path with BuildingController/FinanceController — same safety argument as
 * FinanceController's own doc comment: Nest resolves by full path across
 * controllers, and no method+path pair collides with `votes`.
 *
 * Authorization (06.06 Rule 001: "Only Authorized Governance Roles Can
 * Create Votes" — Verified Manager or Board Member): `VerifiedRolesGuard`
 * (21_ADRs > ADR-038 — a PROVISIONAL or SUSPENDED manager does NOT pass;
 * a MANAGER row only counts once `managerState` is VERIFIED) + `@Roles
 * ('MANAGER', 'BOARD_MEMBER')` for creating/publishing/closing/cancelling
 * a vote; `MembershipGuard` (any current member) for reading votes/results
 * and for casting a ballot — `VotingService.castBallot` itself enforces
 * that the caller is the specific unit's eligible voter, so membership
 * alone is not sufficient to actually vote, just to reach the endpoint.
 */
@ApiTags('governance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class VotingController {
  constructor(
    private readonly voting: VotingService,
    private readonly voteProxies: VoteProxyService,
  ) {}

  @Post(':id/votes')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  createVote(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVoteDto,
    @RequestId() requestId: string,
  ) {
    return this.voting.createVote(id, dto, user.sub, requestId);
  }

  @Get(':id/votes')
  @UseGuards(MembershipGuard)
  listVotes(
    @Param('id') id: string,
    @Query('category') category?: VoteCategory,
    @Query('status') status?: VoteStatus,
  ) {
    return this.voting.listVotes(id, category, status);
  }

  @Get(':id/votes/:voteId')
  @UseGuards(MembershipGuard)
  getVote(@Param('id') id: string, @Param('voteId') voteId: string) {
    return this.voting.getVote(id, voteId);
  }

  @Patch(':id/votes/:voteId/publish')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  publishVote(
    @Param('id') id: string,
    @Param('voteId') voteId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.voting.publishVote(id, voteId, user.sub, requestId);
  }

  @Post(':id/votes/:voteId/ballots')
  @UseGuards(MembershipGuard)
  castBallot(
    @Param('id') id: string,
    @Param('voteId') voteId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CastBallotDto,
    @RequestId() requestId: string,
  ) {
    return this.voting.castBallot(id, voteId, dto, user.sub, requestId);
  }

  @Patch(':id/votes/:voteId/close')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  closeVote(
    @Param('id') id: string,
    @Param('voteId') voteId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.voting.closeVote(id, voteId, user.sub, requestId);
  }

  @Patch(':id/votes/:voteId/cancel')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  cancelVote(
    @Param('id') id: string,
    @Param('voteId') voteId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CancelVoteDto,
    @RequestId() requestId: string,
  ) {
    return this.voting.cancelVote(id, voteId, dto, user.sub, requestId);
  }

  @Get(':id/votes/:voteId/results')
  @UseGuards(MembershipGuard)
  getResult(@Param('id') id: string, @Param('voteId') voteId: string) {
    return this.voting.getResult(id, voteId);
  }

  // --- Standing Proxy Voting (08.07 Rule 011/012 — see 21_ADRs > ADR-089) --
  //
  // Nested under `:id/units/:unitId`, same route-nesting convention
  // `BuildingController`'s own Ownership Transfer/Tenancy routes already
  // use for unit-scoped self-service rights. Lives on THIS controller
  // (not BuildingController) because appointing/revoking a proxy is a
  // Governance/Voting concern (08.07's own API section), not a general
  // membership action — `VoteProxyService` already depends on
  // `BuildingRepository` the same way `VotingService` itself does.
  // `MembershipGuard` only: the actual self-service check (only the
  // unit's live eligible voter may grant; only the granter may revoke)
  // happens inside `VoteProxyService` itself, same posture as
  // `BuildingController.transferOwnership`'s own comment.

  @Get(':id/units/:unitId/vote-proxy')
  @UseGuards(MembershipGuard)
  getCurrentProxy(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.voteProxies.getCurrent(id, unitId);
  }

  @Post(':id/units/:unitId/vote-proxy')
  @UseGuards(MembershipGuard)
  grantProxy(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: GrantVoteProxyDto,
    @RequestId() requestId: string,
  ) {
    return this.voteProxies.grant(id, unitId, dto, user.sub, requestId);
  }

  @Post(':id/units/:unitId/vote-proxy/revoke')
  @UseGuards(MembershipGuard)
  revokeProxy(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.voteProxies.revoke(id, unitId, user.sub, requestId);
  }
}
