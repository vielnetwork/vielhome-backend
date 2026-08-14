import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { VoteCategory, VoteStatus } from '@prisma/client';
import { GovernanceAdministrationService } from '../application/governance-administration.service';
import { CreateVoteDto } from '../../governance/application/dto/create-vote.dto';
import { CancelVoteDto } from '../../governance/application/dto/cancel-vote.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Governance Staff Admin Backend Enablement — the platform-staff
 * administrative path over Governance Voting the BO-C1E audit found
 * missing (`VotingController`'s own guards are `VerifiedRolesGuard`/
 * `MembershipGuard`, both building-Membership concepts platform staff
 * deliberately never hold — see that audit's authorization verdict).
 *
 * Same `backoffice/buildings` base path as `BuildingAdministrationController`
 * (21_ADRs > ADR-112) — same safety argument that controller's own doc
 * comment and `VotingController`'s own (for the member-facing `buildings`
 * base path it shares with `FinanceController`) already make: Nest
 * resolves by full path across controllers, and no method+path pair here
 * collides with that controller's `GET/POST backoffice/buildings...`
 * routes. Same guard stack and `@PlatformRoles`/`@RequiresPermission`
 * tiering convention as `BuildingAdministrationController`: reads
 * (List/Detail/Results) gated `REVIEWER`+ + `GOVERNANCE_VIEW`; every
 * mutation (Create/Publish/Close/Cancel) gated `SENIOR_REVIEWER`+ +
 * `GOVERNANCE_MANAGE`.
 *
 * Deliberately has NO ballot-casting or Vote Proxy route — both remain
 * member-identity-driven only (see `GovernanceAdministrationService`'s
 * own doc comment for why).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/buildings', version: '1' })
export class GovernanceAdministrationController {
  constructor(private readonly service: GovernanceAdministrationService) {}

  @Get(':buildingId/votes')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('GOVERNANCE_VIEW')
  async listVotes(
    @Param('buildingId') buildingId: string,
    @Query('category') category?: VoteCategory,
    @Query('status') status?: VoteStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.listVotes(
      buildingId,
      category,
      status,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':buildingId/votes/:voteId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('GOVERNANCE_VIEW')
  getVote(@Param('buildingId') buildingId: string, @Param('voteId') voteId: string) {
    return this.service.getVote(buildingId, voteId);
  }

  @Get(':buildingId/votes/:voteId/results')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('GOVERNANCE_VIEW')
  getResult(@Param('buildingId') buildingId: string, @Param('voteId') voteId: string) {
    return this.service.getResult(buildingId, voteId);
  }

  @Post(':buildingId/votes')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GOVERNANCE_MANAGE')
  createVote(
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateVoteDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.createVote(buildingId, dto, user.sub, requestId);
  }

  @Patch(':buildingId/votes/:voteId/publish')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GOVERNANCE_MANAGE')
  publishVote(
    @Param('buildingId') buildingId: string,
    @Param('voteId') voteId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.publishVote(buildingId, voteId, user.sub, requestId);
  }

  @Patch(':buildingId/votes/:voteId/close')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GOVERNANCE_MANAGE')
  closeVote(
    @Param('buildingId') buildingId: string,
    @Param('voteId') voteId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.closeVote(buildingId, voteId, user.sub, requestId);
  }

  @Patch(':buildingId/votes/:voteId/cancel')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GOVERNANCE_MANAGE')
  cancelVote(
    @Param('buildingId') buildingId: string,
    @Param('voteId') voteId: string,
    @Body() dto: CancelVoteDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.cancelVote(buildingId, voteId, dto, user.sub, requestId);
  }
}
