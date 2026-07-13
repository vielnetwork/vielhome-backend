import { Injectable } from '@nestjs/common';
import { UnitType, VoteCategory, VoteResultStatus, VoteScopeType, VoteStatus } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

@Injectable()
export class VotingRepository {
  constructor(private readonly prisma: PrismaService) {}

  createVote(params: {
    buildingId: string;
    title: string;
    description?: string;
    category: VoteCategory;
    isManagerElection: boolean;
    quorumPercent?: number;
    startAt: Date;
    endAt: Date;
    createdById: string;
    meetingId?: string;
    scopeType: VoteScopeType;
    scopeBlockId?: string;
    scopeUnitType?: UnitType;
    scopeUnitIds?: string[];
    options: Array<{ label: string; value: string; sortOrder: number }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const vote = await tx.vote.create({
        data: {
          buildingId: params.buildingId,
          title: params.title,
          description: params.description,
          category: params.category,
          isManagerElection: params.isManagerElection,
          quorumPercent: params.quorumPercent,
          startAt: params.startAt,
          endAt: params.endAt,
          createdById: params.createdById,
          meetingId: params.meetingId,
          scopeType: params.scopeType,
          scopeBlockId: params.scopeBlockId,
          scopeUnitType: params.scopeUnitType,
          scopeUnitIds: params.scopeUnitIds ?? [],
          status: 'DRAFT',
        },
      });

      await tx.voteOption.createMany({
        data: params.options.map((o) => ({
          voteId: vote.id,
          label: o.label,
          value: o.value,
          sortOrder: o.sortOrder,
        })),
      });

      return vote;
    });
  }

  findVoteById(id: string) {
    return this.prisma.vote.findUnique({
      where: { id },
      include: { options: { orderBy: { sortOrder: 'asc' } }, result: true },
    });
  }

  listVotes(buildingId: string, filter?: { category?: VoteCategory; status?: VoteStatus }) {
    return this.prisma.vote.findMany({
      where: { buildingId, ...(filter?.category ? { category: filter.category } : {}), ...(filter?.status ? { status: filter.status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  countOptions(voteId: string): Promise<number> {
    return this.prisma.voteOption.count({ where: { voteId } });
  }

  listOptions(voteId: string) {
    return this.prisma.voteOption.findMany({ where: { voteId }, orderBy: { sortOrder: 'asc' } });
  }

  /**
   * DRAFT -> ACTIVE, plus captures the eligibility snapshot (one row per
   * Unit that has EXACTLY ONE current Owner right now — see the MVP
   * simplification note in `schema.prisma`'s Governance section for units
   * with zero/multiple current owners). Both happen in one transaction so
   * a vote is never left ACTIVE without its snapshot, or vice versa.
   *
   * 21_ADRs > ADR-058 — the candidate unit pool is narrowed by
   * `Vote.scopeType` (06.06 Rule 003) BEFORE the existing single-owner
   * eligibility filter runs; `ENTIRE_BUILDING` (the default) reproduces
   * this method's exact pre-ADR-058 behavior with no query change.
   */
  publishVote(voteId: string, buildingId: string) {
    return this.prisma.$transaction(async (tx) => {
      const vote = await tx.vote.update({
        where: { id: voteId },
        data: { status: 'ACTIVE', publishedAt: new Date() },
      });

      const scopeFilter: Record<string, unknown> = {};
      if (vote.scopeType === 'BLOCK' && vote.scopeBlockId) {
        scopeFilter.blockId = vote.scopeBlockId;
      } else if (vote.scopeType === 'PROPERTY_TYPE' && vote.scopeUnitType) {
        scopeFilter.type = vote.scopeUnitType;
      } else if (vote.scopeType === 'SELECTED_UNITS' && vote.scopeUnitIds.length > 0) {
        scopeFilter.id = { in: vote.scopeUnitIds };
      }

      const units = await tx.unit.findMany({
        where: { buildingId, ...scopeFilter },
        include: { ownerships: { where: { isCurrent: true }, select: { personId: true } } },
      });

      const eligible = units.filter((u) => u.ownerships.length === 1);

      if (eligible.length > 0) {
        await tx.voteEligibilitySnapshot.createMany({
          data: eligible.map((u) => ({
            voteId,
            unitId: u.id,
            eligiblePersonId: u.ownerships[0].personId,
            eligibilityType: 'OWNER',
          })),
        });
      }

      return vote;
    });
  }

  listEligibilitySnapshots(voteId: string) {
    return this.prisma.voteEligibilitySnapshot.findMany({ where: { voteId } });
  }

  findEligibilitySnapshotForUnit(voteId: string, unitId: string) {
    return this.prisma.voteEligibilitySnapshot.findUnique({ where: { voteId_unitId: { voteId, unitId } } });
  }

  findBallotForUnit(voteId: string, unitId: string) {
    return this.prisma.ballot.findUnique({ where: { voteId_unitId: { voteId, unitId } } });
  }

  createBallot(params: { voteId: string; unitId: string; voterPersonId: string; selectedOptionId: string }) {
    return this.prisma.ballot.create({ data: params });
  }

  listBallots(voteId: string) {
    return this.prisma.ballot.findMany({ where: { voteId }, include: { selectedOption: true } });
  }

  /**
   * ACTIVE -> CLOSED plus writes the (already-computed by
   * `VotingService.closeVote`) `VoteResult` row, in one transaction — a
   * vote is never left CLOSED without a result, or vice versa. Results
   * publish immediately on close in this MVP (see schema.prisma section
   * note: Close/Calculate/Publish collapse into one step).
   */
  closeVote(params: {
    voteId: string;
    totalEligibleCount: number;
    totalBallotCount: number;
    quorumMet: boolean;
    winningOptionId: string | null;
    resultStatus: VoteResultStatus;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const vote = await tx.vote.update({
        where: { id: params.voteId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });

      const result = await tx.voteResult.create({
        data: {
          voteId: params.voteId,
          totalEligibleCount: params.totalEligibleCount,
          totalBallotCount: params.totalBallotCount,
          quorumMet: params.quorumMet,
          winningOptionId: params.winningOptionId,
          resultStatus: params.resultStatus,
          publishedAt: new Date(),
        },
      });

      return { vote, result };
    });
  }

  /**
   * DRAFT votes whose configured `startAt` has passed — the query-side
   * counterpart to the scheduler's auto-publish sweep (21_ADRs > ADR-036).
   * Manual `publishVote` (an authorized role, any time) is unaffected.
   */
  findVotesDueForAutoPublish() {
    return this.prisma.vote.findMany({
      where: { status: 'DRAFT', startAt: { lte: new Date() } },
      select: { id: true, buildingId: true },
    });
  }

  /**
   * ACTIVE votes whose configured `endAt` has passed — the query-side
   * counterpart to the scheduler's auto-close sweep (21_ADRs > ADR-036).
   */
  findVotesDueForAutoClose() {
    return this.prisma.vote.findMany({
      where: { status: 'ACTIVE', endAt: { lte: new Date() } },
      select: { id: true, buildingId: true },
    });
  }

  cancelVote(id: string, reason?: string) {
    return this.prisma.vote.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
  }

  getResult(voteId: string) {
    return this.prisma.voteResult.findUnique({
      where: { voteId },
      include: { winningOption: true },
    });
  }
}
