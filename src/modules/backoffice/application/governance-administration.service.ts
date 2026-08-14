import { Injectable } from '@nestjs/common';
import type { VoteCategory, VoteStatus } from '@prisma/client';
import { VotingService } from '../../governance/application/voting.service';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { CreateVoteDto } from '../../governance/application/dto/create-vote.dto';
import { CancelVoteDto } from '../../governance/application/dto/cancel-vote.dto';
import { NotFoundAppError } from '../../../common/errors/app-error';
import type { PaginationParams } from '../../../common/pagination/pagination.util';

/**
 * Governance Staff Admin Backend Enablement — a thin delegation layer,
 * NOT a reimplementation. Every Vote lifecycle rule (DRAFT-only publish,
 * ACTIVE-only close, eligibility snapshot capture, quorum/tally
 * calculation, manager-election handoff, CAS concurrency protection,
 * audit, notifications) lives in `VotingService`/`VotingRepository`/
 * `VotePolicy` exactly as it already does for the member-facing
 * `VotingController` — this service adds exactly two things member
 * callers don't need: (1) an explicit Building-existence check (platform
 * staff are global, not building members — `MembershipGuard` on the
 * member-facing controller incidentally guarantees a real building via
 * membership; nothing does that for a staff caller), and (2) tagging
 * every call `actorContext: 'PLATFORM_STAFF'` so the audit trail can
 * distinguish a staff-administered Vote from a building-member one.
 *
 * Deliberately has NO `castBallot`/proxy methods — Ballot casting and
 * Vote Proxy administration remain member-identity-driven only (see
 * `VotingService.castBallot`'s own doc comment: eligibility is resolved
 * entirely from the caller's own identity against the vote's eligibility
 * snapshot or a live proxy match — a platform-staff caller could never
 * satisfy that check even if a route existed, so no route exists).
 */
@Injectable()
export class GovernanceAdministrationService {
  constructor(
    private readonly voting: VotingService,
    private readonly buildings: BuildingRepository,
  ) {}

  private async assertBuildingExists(buildingId: string): Promise<void> {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
  }

  async listVotes(
    buildingId: string,
    category: VoteCategory | undefined,
    status: VoteStatus | undefined,
    pagination: PaginationParams,
  ) {
    await this.assertBuildingExists(buildingId);
    return this.voting.listVotes(buildingId, category, status, pagination);
  }

  async getVote(buildingId: string, voteId: string) {
    await this.assertBuildingExists(buildingId);
    return this.voting.getVote(buildingId, voteId);
  }

  async getResult(buildingId: string, voteId: string) {
    await this.assertBuildingExists(buildingId);
    return this.voting.getResult(buildingId, voteId);
  }

  async createVote(
    buildingId: string,
    dto: CreateVoteDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.assertBuildingExists(buildingId);
    return this.voting.createVote(buildingId, dto, actorPersonId, requestId, 'PLATFORM_STAFF');
  }

  async publishVote(buildingId: string, voteId: string, actorPersonId: string, requestId: string) {
    await this.assertBuildingExists(buildingId);
    return this.voting.publishVote(buildingId, voteId, actorPersonId, requestId, 'PLATFORM_STAFF');
  }

  async closeVote(buildingId: string, voteId: string, actorPersonId: string, requestId: string) {
    await this.assertBuildingExists(buildingId);
    return this.voting.closeVote(buildingId, voteId, actorPersonId, requestId, 'PLATFORM_STAFF');
  }

  async cancelVote(
    buildingId: string,
    voteId: string,
    dto: CancelVoteDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.assertBuildingExists(buildingId);
    return this.voting.cancelVote(
      buildingId,
      voteId,
      dto,
      actorPersonId,
      requestId,
      'PLATFORM_STAFF',
    );
  }
}
