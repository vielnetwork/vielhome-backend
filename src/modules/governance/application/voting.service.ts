import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { VoteCategory, VoteResultStatus, VoteStatus } from '@prisma/client';
import { VotingRepository } from '../infrastructure/repositories/voting.repository';
import { MeetingRepository } from '../infrastructure/repositories/meeting.repository';
import { VoteProxyRepository } from '../infrastructure/repositories/vote-proxy.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { BuildingService } from '../../building/application/building.service';
import { VotePolicy } from '../domain/policies/vote.policy';
import { CreateVoteDto } from './dto/create-vote.dto';
import { CastBallotDto } from './dto/cast-ballot.dto';
import { CancelVoteDto } from './dto/cancel-vote.dto';
import { AuditService } from '../../../common/audit/audit.service';
import {
  BusinessRuleViolationError,
  DuplicateError,
  NotFoundAppError,
} from '../../../common/errors/app-error';
import {
  BallotCastEvent,
  VoteCancelledEvent,
  VoteClosedEvent,
  VotePublishedEvent,
} from '../events/vote.events';

const DEFAULT_REFERENDUM_OPTIONS = [
  { label: 'موافق', value: 'YES' },
  { label: 'مخالف', value: 'NO' },
  { label: 'ممتنع', value: 'ABSTAIN' },
];

/** 06.06 Rule 011/012/013/014: quorum is a percentage of eligible units that must have cast a ballot, evaluated at closure. No quorum requirement means it's always considered met. */
function isQuorumMet(
  quorumPercent: number | null,
  totalEligibleCount: number,
  totalBallotCount: number,
): boolean {
  if (quorumPercent == null) return true;
  if (totalEligibleCount === 0) return false;
  return totalBallotCount * 100 >= quorumPercent * totalEligibleCount;
}

@Injectable()
export class VotingService {
  private readonly logger = new Logger(VotingService.name);

  constructor(
    private readonly voting: VotingRepository,
    private readonly meetings: MeetingRepository,
    private readonly voteProxies: VoteProxyRepository,
    private readonly buildings: BuildingRepository,
    private readonly buildingService: BuildingService,
    private readonly policy: VotePolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  async createVote(
    buildingId: string,
    dto: CreateVoteDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);

    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    this.policy.assertValidVoteWindow(startAt, endAt);

    const isManagerElection = dto.isManagerElection ?? false;

    if (isManagerElection && (!dto.options || dto.options.length === 0)) {
      throw new BusinessRuleViolationError(
        'A manager-election vote requires explicit candidate options.',
      );
    }

    const rawOptions =
      dto.options && dto.options.length > 0 ? dto.options : DEFAULT_REFERENDUM_OPTIONS;

    if (isManagerElection) {
      const candidatePersonIds = rawOptions.map((o) => o.value);
      this.policy.assertValidElectionOptions(candidatePersonIds);

      const memberships = await Promise.all(
        candidatePersonIds.map((personId) => this.buildings.getRoles(personId, buildingId)),
      );
      const ineligible = candidatePersonIds.filter((_, i) => memberships[i].length === 0);
      if (ineligible.length > 0) {
        throw new BusinessRuleViolationError(
          'Every candidate in a manager-election vote must be a current member of this building.',
          { ineligiblePersonIds: ineligible },
        );
      }
    }

    // 04.06 Rule 11 — a vote MAY belong to a Meeting; when given, the
    // Meeting must exist in this same building (same double-check pattern
    // as `MeetingService.getMeetingOrThrow`) — see 21_ADRs > ADR-049.
    if (dto.meetingId) {
      const meeting = await this.meetings.findById(dto.meetingId);
      if (!meeting || meeting.buildingId !== buildingId) {
        throw new BusinessRuleViolationError(
          'The referenced meeting does not exist in this building.',
        );
      }
    }

    // 21_ADRs > ADR-058 — 06.06 Rule 003. `scopeType` defaults to
    // ENTIRE_BUILDING when omitted, preserving every existing caller's
    // behavior. The policy checks internal consistency (right companion
    // field for the scope, no stray extras); this service then checks that
    // a given scopeBlockId/scopeUnitIds actually belongs to THIS building —
    // a database lookup the policy layer deliberately never performs.
    const scopeType = dto.scopeType ?? 'ENTIRE_BUILDING';
    this.policy.assertValidScope({
      scopeType,
      scopeBlockId: dto.scopeBlockId,
      scopeUnitType: dto.scopeUnitType,
      scopeUnitIds: dto.scopeUnitIds,
    });

    if (scopeType === 'BLOCK' && dto.scopeBlockId) {
      const block = await this.buildings.findBlockById(dto.scopeBlockId);
      if (!block || block.buildingId !== buildingId) {
        throw new BusinessRuleViolationError(
          'scopeBlockId does not refer to a Block in this building.',
        );
      }
    }

    if (scopeType === 'SELECTED_UNITS' && dto.scopeUnitIds && dto.scopeUnitIds.length > 0) {
      const matchCount = await this.buildings.countUnitsByIdsInBuilding(
        buildingId,
        dto.scopeUnitIds,
      );
      if (matchCount !== dto.scopeUnitIds.length) {
        throw new BusinessRuleViolationError(
          'scopeUnitIds must all refer to Units in this building.',
        );
      }
    }

    const vote = await this.voting.createVote({
      buildingId,
      title: dto.title,
      description: dto.description,
      category: dto.category,
      isManagerElection,
      quorumPercent: dto.quorumPercent,
      startAt,
      endAt,
      createdById: actorPersonId,
      meetingId: dto.meetingId,
      scopeType,
      scopeBlockId: dto.scopeBlockId,
      scopeUnitType: dto.scopeUnitType,
      scopeUnitIds: dto.scopeUnitIds,
      options: rawOptions.map((o, i) => ({ label: o.label, value: o.value, sortOrder: i })),
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'VoteCreated',
      entityType: 'Vote',
      entityId: vote.id,
      requestId,
      metadata: { category: dto.category, isManagerElection, scopeType },
    });

    return this.voting.findVoteById(vote.id);
  }

  listVotes(buildingId: string, category?: VoteCategory, status?: VoteStatus) {
    return this.voting.listVotes(buildingId, { category, status });
  }

  async getVote(buildingId: string, voteId: string) {
    const vote = await this.voting.findVoteById(voteId);
    if (!vote || vote.buildingId !== buildingId) {
      throw new NotFoundAppError('Vote not found.');
    }
    return vote;
  }

  async publishVote(
    buildingId: string,
    voteId: string,
    actorPersonId: string | undefined,
    requestId: string,
  ) {
    const vote = await this.getVote(buildingId, voteId);
    this.policy.assertPublishable(vote.status, vote.options.length);

    // 21_ADRs > ADR-089 — resolved once, here, and passed down rather than
    // read inside `VotingRepository.publishVote` itself: keeps the
    // repository's own transaction free of a second cross-domain-flavored
    // read, and matches how every other per-building policy value already
    // flows into this service (e.g. `dto.scopeType` above).
    const { allowTenantVoting } = await this.buildings.getBuildingSettings(buildingId);
    const published = await this.voting.publishVote(voteId, buildingId, allowTenantVoting);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'VotePublished',
      entityType: 'Vote',
      entityId: voteId,
      requestId,
    });

    this.events.emit('VotePublished', new VotePublishedEvent(voteId, buildingId, actorPersonId));

    return published;
  }

  /**
   * Casts a ballot on behalf of `dto.unitId`, not the caller directly
   * (04.06 Rule 1/2: the vote belongs to the Property). The caller must be
   * either that unit's sole eligible voter as of the vote's eligibility
   * snapshot, or (21_ADRs > ADR-089) that person's current standing proxy
   * — see the MVP simplification note in schema.prisma for why co-owned
   * units simply have no eligible voter rather than a simulated Abstain.
   */
  async castBallot(
    buildingId: string,
    voteId: string,
    dto: CastBallotDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const vote = await this.getVote(buildingId, voteId);
    this.policy.assertOpenForBallots(vote.status, vote.endAt);

    const unit = await this.buildings.findUnitById(dto.unitId);
    if (!unit || unit.buildingId !== buildingId) {
      throw new NotFoundAppError('Unit not found.');
    }

    const snapshot = await this.voting.findEligibilitySnapshotForUnit(voteId, dto.unitId);
    if (!snapshot) {
      throw new BusinessRuleViolationError('This unit is not eligible to vote on this vote.');
    }

    // 21_ADRs > ADR-089 — a live check (not frozen into the snapshot):
    // proxy status can change after publish, and revoking a proxy stops
    // it working immediately. See `VoteProxy`'s own schema comment for
    // the disclosed "self-healing" property this gives.
    const isDirectMatch = snapshot.eligiblePersonId === actorPersonId;
    const isProxyMatch =
      !isDirectMatch &&
      (await this.voteProxies.isCurrentProxyFor(snapshot.eligiblePersonId, actorPersonId));
    this.policy.assertEligibleToCastBallot(isDirectMatch, isProxyMatch);

    const existing = await this.voting.findBallotForUnit(voteId, dto.unitId);
    if (existing) {
      throw new DuplicateError('This unit has already voted on this vote.');
    }

    const option = vote.options.find((o) => o.id === dto.selectedOptionId);
    if (!option) {
      throw new NotFoundAppError('Vote option not found.');
    }

    if (vote.isManagerElection) {
      // 21_ADRs > ADR-089 — checks the UNIT's own eligible voter
      // (`snapshot.eligiblePersonId`), not the physical caster
      // (`actorPersonId`). Before proxy voting existed the two were
      // always identical at this point (the guard above required an
      // exact match), so this is not a behavior change for direct
      // voting — but it closes a real evasion path a candidate could
      // otherwise use: appointing a proxy to cast on their own unit's
      // behalf would previously have passed this check (the PROXY
      // wasn't a candidate, even though the UNIT'S vote effectively was
      // theirs). 04.06 Rule 1 ("Vote Belongs To Property, not Person")
      // read together with Rule 6 ("a candidate cannot vote in their own
      // election") means the property's own vote is what's restricted,
      // regardless of who is physically holding the pen.
      const candidatePersonIds = vote.options.map((o) => o.value);
      this.policy.assertNotVotingOnOwnCandidacy(
        true,
        snapshot.eligiblePersonId,
        candidatePersonIds,
      );
    }

    const ballot = await this.voting.createBallot({
      voteId,
      unitId: dto.unitId,
      voterPersonId: actorPersonId,
      selectedOptionId: dto.selectedOptionId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'BallotSubmitted',
      entityType: 'Ballot',
      entityId: ballot.id,
      requestId,
      metadata: { voteId, unitId: dto.unitId },
    });

    this.events.emit(
      'BallotCast',
      new BallotCastEvent(voteId, buildingId, dto.unitId, actorPersonId),
    );

    return ballot;
  }

  /**
   * ACTIVE -> CLOSED, calculates and publishes the result in the same
   * step (see schema.prisma's Governance section note), and — for a
   * manager-election vote that PASSED — feeds the winner straight into
   * `BuildingService.changeManager(..., 'ELECTED')` (06.06 Rule 015). The
   * election handoff is best-effort: if it fails (e.g. the winner is no
   * longer a member), the vote still closes and its result still
   * publishes — a failed handoff is audited, not silently swallowed, but
   * it never blocks the vote itself from closing honestly.
   */
  async closeVote(
    buildingId: string,
    voteId: string,
    actorPersonId: string | undefined,
    requestId: string,
  ) {
    const vote = await this.getVote(buildingId, voteId);
    this.policy.assertClosable(vote.status);

    const [snapshots, ballots] = await Promise.all([
      this.voting.listEligibilitySnapshots(voteId),
      this.voting.listBallots(voteId),
    ]);

    const totalEligibleCount = snapshots.length;
    const totalBallotCount = ballots.length;
    const quorumMet = isQuorumMet(vote.quorumPercent, totalEligibleCount, totalBallotCount);

    // 06.06 Rule 014: Abstain counts for participation/quorum (already
    // reflected in totalBallotCount above) but never for the winner.
    const tally = new Map<string, number>();
    for (const ballot of ballots) {
      if (ballot.selectedOption.value === 'ABSTAIN') continue;
      tally.set(ballot.selectedOptionId, (tally.get(ballot.selectedOptionId) ?? 0) + 1);
    }

    let winningOptionId: string | null = null;
    let topCount = 0;
    let tie = false;
    for (const [optionId, count] of tally) {
      if (count > topCount) {
        winningOptionId = optionId;
        topCount = count;
        tie = false;
      } else if (count === topCount && count > 0) {
        tie = true;
      }
    }
    if (tie) winningOptionId = null;

    const resultStatus: VoteResultStatus = !quorumMet
      ? 'QUORUM_NOT_MET'
      : winningOptionId
        ? 'PASSED'
        : 'NOT_PASSED';

    const { vote: closedVote, result } = await this.voting.closeVote({
      voteId,
      totalEligibleCount,
      totalBallotCount,
      quorumMet,
      winningOptionId,
      resultStatus,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'VoteClosed',
      entityType: 'Vote',
      entityId: voteId,
      requestId,
      metadata: { resultStatus, totalEligibleCount, totalBallotCount, quorumMet },
    });

    this.events.emit(
      'VoteClosed',
      new VoteClosedEvent(voteId, buildingId, resultStatus, actorPersonId),
    );

    if (vote.isManagerElection && resultStatus === 'PASSED' && winningOptionId) {
      const winningOption = vote.options.find((o) => o.id === winningOptionId);
      if (winningOption) {
        try {
          await this.buildingService.changeManager(
            buildingId,
            winningOption.value,
            'ELECTED',
            actorPersonId,
            requestId,
          );
          await this.audit.record({
            actorId: actorPersonId,
            buildingId,
            action: 'ManagerElectedViaVote',
            entityType: 'Vote',
            entityId: voteId,
            requestId,
            metadata: { newManagerPersonId: winningOption.value },
          });
        } catch (err) {
          this.logger.error(
            `Manager election handoff failed for vote=${voteId} winner=${winningOption.value}`,
            (err as Error)?.stack,
          );
          await this.audit.record({
            actorId: actorPersonId,
            buildingId,
            action: 'ManagerElectionFailed',
            entityType: 'Vote',
            entityId: voteId,
            requestId,
            reason: (err as Error)?.message,
          });
        }
      }
    }

    return { vote: closedVote, result };
  }

  async cancelVote(
    buildingId: string,
    voteId: string,
    dto: CancelVoteDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const vote = await this.getVote(buildingId, voteId);
    this.policy.assertCancellable(vote.status);

    const cancelled = await this.voting.cancelVote(voteId, dto.reason);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'VoteCancelled',
      entityType: 'Vote',
      entityId: voteId,
      requestId,
      reason: dto.reason,
    });

    this.events.emit('VoteCancelled', new VoteCancelledEvent(voteId, buildingId, actorPersonId));

    return cancelled;
  }

  async getResult(buildingId: string, voteId: string) {
    await this.getVote(buildingId, voteId);
    const result = await this.voting.getResult(voteId);
    if (!result) {
      throw new NotFoundAppError('This vote has not been closed yet.');
    }
    return result;
  }

  /**
   * Scheduler entry point (21_ADRs > ADR-036) — auto-publishes every DRAFT
   * vote whose `startAt` has passed, reusing `publishVote`'s exact same
   * logic with no staff actor. One vote failing (e.g. it somehow has zero
   * options) is logged and audited but never blocks the rest of the sweep.
   */
  async runAutoPublish(requestId: string) {
    const due = await this.voting.findVotesDueForAutoPublish();
    const results: Array<{ voteId: string; ok: boolean; error?: string }> = [];
    for (const v of due) {
      try {
        await this.publishVote(v.buildingId, v.id, undefined, requestId);
        results.push({ voteId: v.id, ok: true });
      } catch (err) {
        this.logger.error(`Auto-publish failed for vote=${v.id}`, (err as Error)?.stack);
        await this.audit.record({
          buildingId: v.buildingId,
          action: 'VoteAutoPublishFailed',
          entityType: 'Vote',
          entityId: v.id,
          requestId,
          reason: (err as Error)?.message,
        });
        results.push({ voteId: v.id, ok: false, error: (err as Error)?.message });
      }
    }
    return results;
  }

  /**
   * Scheduler entry point (21_ADRs > ADR-036) — auto-closes every ACTIVE
   * vote whose `endAt` has passed, reusing `closeVote`'s exact same
   * tally/quorum/manager-election logic with no staff actor.
   */
  async runAutoClose(requestId: string) {
    const due = await this.voting.findVotesDueForAutoClose();
    const results: Array<{ voteId: string; ok: boolean; error?: string }> = [];
    for (const v of due) {
      try {
        await this.closeVote(v.buildingId, v.id, undefined, requestId);
        results.push({ voteId: v.id, ok: true });
      } catch (err) {
        this.logger.error(`Auto-close failed for vote=${v.id}`, (err as Error)?.stack);
        await this.audit.record({
          buildingId: v.buildingId,
          action: 'VoteAutoCloseFailed',
          entityType: 'Vote',
          entityId: v.id,
          requestId,
          reason: (err as Error)?.message,
        });
        results.push({ voteId: v.id, ok: false, error: (err as Error)?.message });
      }
    }
    return results;
  }
}
