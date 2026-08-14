import { Injectable } from '@nestjs/common';
import { UnitType, VoteCategory, VoteScopeType, VoteStatus } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { VotePolicy } from '../../domain/policies/vote.policy';
import { BusinessRuleViolationError, ConflictError } from '../../../../common/errors/app-error';

@Injectable()
export class VotingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: VotePolicy,
  ) {}

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

  /**
   * Governance Hardening Phase 2 (audit §44) — paginated, following the
   * same `page`/`limit` -> `skip`/`take` convention `FinanceRepository
   * .listFunds` already established (`common/pagination/pagination.util
   * .ts`, ADR-072/ADR-120). `count` runs alongside `findMany` in the same
   * `Promise.all` rather than sequentially, matching every other paginated
   * repository method in this codebase.
   */
  async listVotes(
    buildingId: string,
    filter: { category?: VoteCategory; status?: VoteStatus },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      buildingId,
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.vote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.vote.count({ where }),
    ]);
    return { items, total };
  }

  countOptions(voteId: string): Promise<number> {
    return this.prisma.voteOption.count({ where: { voteId } });
  }

  listOptions(voteId: string) {
    return this.prisma.voteOption.findMany({ where: { voteId }, orderBy: { sortOrder: 'asc' } });
  }

  /**
   * DRAFT -> ACTIVE, plus captures the eligibility snapshot (one row per
   * eligible Unit right now). Both happen in one transaction so a vote is
   * never left ACTIVE without its snapshot, or vice versa.
   *
   * 21_ADRs > ADR-058 — the candidate unit pool is narrowed by
   * `Vote.scopeType` (06.06 Rule 003) BEFORE the eligibility filter runs;
   * `ENTIRE_BUILDING` (the default) reproduces this method's exact
   * pre-ADR-058 behavior with no query change.
   *
   * 21_ADRs > ADR-089 — `allowTenantVoting` (resolved by the caller from
   * `BuildingRepository.getBuildingSettings`, this method never reads it
   * itself) picks the eligibility rule per unit: when `false` (every
   * building's state before this ADR, and the default for every building
   * after it), behavior is byte-for-byte unchanged — a unit is eligible
   * only if it has EXACTLY ONE current Owner (see the MVP simplification
   * note in `schema.prisma`'s Governance section for units with
   * zero/multiple current owners). When `true`, a unit with EXACTLY ONE
   * current Tenant hands the vote to that tenant instead (`eligibilityType:
   * 'TENANT'`) — an absentee owner does not also get a ballot for the
   * same unit; a unit with zero/multiple current tenants falls back to
   * the owner rule unchanged.
   */
  publishVote(voteId: string, buildingId: string, allowTenantVoting: boolean) {
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
        include: {
          ownerships: { where: { isCurrent: true }, select: { personId: true } },
          tenancies: { where: { isCurrent: true }, select: { personId: true } },
        },
      });

      const eligible: Array<{
        unitId: string;
        eligiblePersonId: string;
        eligibilityType: 'OWNER' | 'TENANT';
      }> = [];
      for (const u of units) {
        if (allowTenantVoting && u.tenancies.length === 1) {
          eligible.push({
            unitId: u.id,
            eligiblePersonId: u.tenancies[0].personId,
            eligibilityType: 'TENANT',
          });
        } else if (u.ownerships.length === 1) {
          eligible.push({
            unitId: u.id,
            eligiblePersonId: u.ownerships[0].personId,
            eligibilityType: 'OWNER',
          });
        }
      }

      if (eligible.length > 0) {
        await tx.voteEligibilitySnapshot.createMany({
          data: eligible.map((e) => ({
            voteId,
            unitId: e.unitId,
            eligiblePersonId: e.eligiblePersonId,
            eligibilityType: e.eligibilityType,
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
    return this.prisma.voteEligibilitySnapshot.findUnique({
      where: { voteId_unitId: { voteId, unitId } },
    });
  }

  findBallotForUnit(voteId: string, unitId: string) {
    return this.prisma.ballot.findUnique({ where: { voteId_unitId: { voteId, unitId } } });
  }

  createBallot(params: {
    voteId: string;
    unitId: string;
    voterPersonId: string;
    selectedOptionId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const vote = await tx.vote.findUnique({
        where: { id: params.voteId },
        select: { status: true, endAt: true },
      });
      if (!vote || vote.status !== 'ACTIVE' || new Date() > vote.endAt) {
        throw new BusinessRuleViolationError('This vote is not currently open for ballots.');
      }
      return tx.ballot.create({ data: params });
    });
  }

  listBallots(voteId: string) {
    return this.prisma.ballot.findMany({ where: { voteId }, include: { selectedOption: true } });
  }

  /**
   * ACTIVE -> CLOSED plus computes and writes the `VoteResult` row, all
   * in one transaction — a vote is never left CLOSED without a result,
   * or vice versa. Results publish immediately on close in this MVP (see
   * schema.prisma section note: Close/Calculate/Publish collapse into
   * one step).
   *
   * Governance Staff Admin Backend Enablement — concurrency hardening.
   * Previously this method unconditionally `update`d the vote's status
   * with no precondition, so a simultaneous `closeVote`/`cancelVote` (or
   * two `closeVote` calls) for the same vote could both pass their
   * pre-read `assertClosable`/`assertCancellable` check and both writes
   * would then succeed unconditionally — leaving a CLOSED vote with a
   * CANCELLED status (or vice versa) with no error to either caller. The
   * `updateMany({ where: { id, status: 'ACTIVE' } })` CAS below (same
   * "expected-status" pattern `CaseRepository.resolveCase`/`closeCase`
   * already establish) guarantees only ONE of two racing
   * close/cancel calls can ever win; the loser gets a clean
   * `ConflictError` (409) instead of silently corrupting the vote.
   *
   * The ballot/snapshot read the tally is computed from was also moved
   * INSIDE this same transaction, AFTER the CAS succeeds (previously read
   * by the service, before this transaction even began) — see
   * `VotePolicy.calculateResult`'s own doc comment for why this closes,
   * not merely narrows, the "a ballot cast in the gap between the read
   * and the close" race.
   */
  closeVote(voteId: string, quorumPercent: number | null) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.vote.updateMany({
        where: { id: voteId, status: 'ACTIVE' },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new ConflictError(
          'This vote is no longer ACTIVE (it may have just been closed or cancelled). Reload and retry.',
        );
      }

      const [snapshots, ballots] = await Promise.all([
        tx.voteEligibilitySnapshot.findMany({ where: { voteId } }),
        tx.ballot.findMany({ where: { voteId }, include: { selectedOption: true } }),
      ]);

      const computed = this.policy.calculateResult(
        quorumPercent,
        snapshots.length,
        ballots.map((b) => ({
          selectedOptionId: b.selectedOptionId,
          optionValue: b.selectedOption.value,
        })),
      );

      const vote = await tx.vote.findUniqueOrThrow({ where: { id: voteId } });
      const result = await tx.voteResult.create({
        data: {
          voteId,
          totalEligibleCount: computed.totalEligibleCount,
          totalBallotCount: computed.totalBallotCount,
          quorumMet: computed.quorumMet,
          winningOptionId: computed.winningOptionId,
          resultStatus: computed.resultStatus,
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

  /**
   * Governance Staff Admin Backend Enablement — concurrency hardening,
   * same CAS pattern as `closeVote` above: `expectedStatus` is whatever
   * status the service's own `assertCancellable` check just read (DRAFT
   * or ACTIVE — the only two `assertCancellable` allows). If the vote's
   * status has since moved on (e.g. a simultaneous `closeVote` won the
   * race), this update matches zero rows and the caller gets a clean
   * `ConflictError` (409) instead of silently cancelling a vote that was
   * already closed (or double-cancelling).
   */
  async cancelVote(id: string, expectedStatus: VoteStatus, reason?: string) {
    const claimed = await this.prisma.vote.updateMany({
      where: { id, status: expectedStatus },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    if (claimed.count !== 1) {
      throw new ConflictError(
        'This vote is no longer in the expected state (it may have just been closed or cancelled). Reload and retry.',
      );
    }
    return this.prisma.vote.findUniqueOrThrow({ where: { id } });
  }

  getResult(voteId: string) {
    return this.prisma.voteResult.findUnique({
      where: { voteId },
      include: { winningOption: true },
    });
  }
}
