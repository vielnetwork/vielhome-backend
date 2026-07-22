import { Module } from '@nestjs/common';
import { VotingController } from './controller/voting.controller';
import { VotingService } from './application/voting.service';
import { VotingRepository } from './infrastructure/repositories/voting.repository';
import { VotePolicy } from './domain/policies/vote.policy';
import { VoteProxyService } from './application/vote-proxy.service';
import { VoteProxyRepository } from './infrastructure/repositories/vote-proxy.repository';
import { VoteProxyPolicy } from './domain/policies/vote-proxy.policy';
import { MeetingController } from './controller/meeting.controller';
import { MeetingService } from './application/meeting.service';
import { MeetingRepository } from './infrastructure/repositories/meeting.repository';
import { MeetingPolicy } from './domain/policies/meeting.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { VerifiedRolesGuard } from '../../common/guards/verified-roles.guard';
import { BuildingModule } from '../building/building.module';

@Module({
  // Reuses BuildingRepository (building/unit lookups, role resolution) and
  // BuildingService (manager-election handoff via changeManager) — both
  // exported by BuildingModule since ADR-022, same pattern FinanceModule
  // already established for BuildingRepository. `VerifiedRolesGuard`
  // (21_ADRs > ADR-038) replaces the plain `RolesGuard` this module used to
  // provide — every route that used to guard on `@Roles('MANAGER', ...)`
  // here now guards on verified-manager-or-Board-Member instead; no route
  // in this controller needs the older "any current MANAGER row" check.
  //
  // Meetings (21_ADRs > ADR-049) join this same module rather than a new
  // one — 04.06_Governance_Rules covers both Voting and Meetings as one
  // source document, and Meetings shares this module's exact
  // BuildingModule/guard dependencies with nothing extra needed.
  imports: [BuildingModule],
  controllers: [VotingController, MeetingController],
  providers: [
    VotingService,
    VotingRepository,
    VotePolicy,
    // Standing Proxy Voting (21_ADRs > ADR-089) — same module as Voting
    // itself (VotingService.castBallot depends on VoteProxyRepository
    // directly; VotingController exposes both services), not a new
    // top-level module.
    VoteProxyService,
    VoteProxyRepository,
    VoteProxyPolicy,
    MeetingService,
    MeetingRepository,
    MeetingPolicy,
    MembershipGuard,
    VerifiedRolesGuard,
  ],
  exports: [VotingService, VotingRepository, MeetingService, MeetingRepository],
})
export class GovernanceModule {}
