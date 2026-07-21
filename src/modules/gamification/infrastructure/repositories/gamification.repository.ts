import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AchievementCode, LeagueTier, XpReason } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { GamificationPolicy } from '../../domain/policies/gamification.policy';

@Injectable()
export class GamificationRepository {
  private readonly logger = new Logger(GamificationRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: GamificationPolicy,
  ) {}

  /**
   * Creates the XpTransaction and increments `Person.xpBalance` in one
   * transaction — same "ledger row + denormalized cache, kept in sync
   * together" pattern as `Fund.balance`. `isFirstOccurrence` tells the
   * caller whether this is the person's first XpTransaction of this
   * reason, which gates achievement unlocking (see xp-catalog.ts).
   */
  async awardXp(params: {
    personId: string;
    buildingId?: string;
    reason: XpReason;
    amount: number;
    sourceEvent?: string;
    referenceType?: string;
    referenceId?: string;
  }): Promise<{ newBalance: number; isFirstOccurrence: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const priorCount = await tx.xpTransaction.count({
        where: { personId: params.personId, reason: params.reason },
      });

      await tx.xpTransaction.create({
        data: {
          personId: params.personId,
          buildingId: params.buildingId,
          reason: params.reason,
          amount: params.amount,
          sourceEvent: params.sourceEvent,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
        },
      });

      const person = await tx.person.update({
        where: { id: params.personId },
        data: { xpBalance: { increment: params.amount } },
      });

      return { newBalance: person.xpBalance, isFirstOccurrence: priorCount === 0 };
    });
  }

  /** Idempotent — returns null if the person already has this achievement (achievements are permanent, never re-unlocked), or if `code` has no seeded `AchievementDefinition` yet (see `prisma/seed.ts`) — a missing seed silently no-ops here rather than throwing, since XP should still award even if the achievement catalog hasn't been seeded in a given environment. */
  async unlockAchievement(
    personId: string,
    code: AchievementCode,
    buildingId?: string,
  ): Promise<{ title: string } | null> {
    const definition = await this.prisma.achievementDefinition.findUnique({ where: { code } });
    if (!definition) return null;

    const existing = await this.prisma.personAchievement.findUnique({
      where: { personId_definitionId: { personId, definitionId: definition.id } },
    });
    if (existing) return null;

    await this.prisma.personAchievement.create({
      data: { personId, definitionId: definition.id, buildingId },
    });

    if (definition.xpBonus > 0) {
      await this.prisma.person.update({
        where: { id: personId },
        data: { xpBalance: { increment: definition.xpBonus } },
      });
    }

    return { title: definition.title };
  }

  /**
   * Upserts the building's BuildingScore row, applies `delta`, recomputes
   * the league tier via `GamificationPolicy`, and — if the tier actually
   * changed — records a BuildingScoreEvent history row. All in one
   * transaction, mirroring `awardXp`'s ledger+cache pattern.
   *
   * 21_ADRs > ADR-079 round-1 fix — a real toolchain run (9 e2e suites
   * running concurrently for the first time, once `gamification.e2e-
   * spec.ts` joined the suite) surfaced a genuine, if narrow, race: this
   * whole sequence runs inside one `$transaction`, but Postgres's default
   * READ COMMITTED isolation still lets a *different*, concurrent
   * transaction's DELETE of this same `buildingId`'s BuildingScore row
   * (only ever issued by an e2e file's own cleanup batch — no production
   * code path ever deletes a BuildingScore row) land in between this
   * transaction's own `findUniqueOrThrow` and its final `update`, so the
   * `update` fails with Prisma's P2025 ("record to update not found")
   * even though the row existed moments earlier in the very same
   * transaction. This can only happen when an un-awaited
   * `EventEmitter2.emit()`-driven XP award (e.g. `CHARGE_PAID`) is still
   * mid-flight for a building whose owning e2e describe block has already
   * finished its own assertions and moved on to `afterAll` cleanup — the
   * same standing "test cleanup races an un-awaited event chain" bug
   * class `ADR-070`/`ADR-074`/`ADR-077` each already found and fixed in
   * their own domains. Since a Building (and therefore its BuildingScore)
   * is never deleted by any real product feature, catching P2025 here and
   * treating it as "this building's gamification state is no longer
   * relevant, safely skip" is correct in production too, not just a test-
   * only workaround — it just happens to be unreachable outside tests
   * today.
   */
  async applyBuildingScoreDelta(
    buildingId: string,
    delta: number,
    reason: string,
    sourceEvent?: string,
  ): Promise<{
    score: number;
    previousTier: LeagueTier;
    newTier: LeagueTier;
    tierChanged: boolean;
  } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.buildingScore.upsert({
          where: { buildingId },
          update: {},
          create: { buildingId, score: 0, leagueTier: 'BRONZE' },
        });

        const before = await tx.buildingScore.findUniqueOrThrow({ where: { buildingId } });
        const newScore = before.score + delta;
        const newTier = this.policy.computeLeagueTier(newScore);

        await tx.buildingScore.update({
          where: { buildingId },
          data: { score: newScore, leagueTier: newTier },
        });

        await tx.buildingScoreEvent.create({
          data: {
            buildingScoreId: before.id,
            delta,
            reason,
            sourceEvent,
            previousTier: before.leagueTier,
            newTier,
          },
        });

        return {
          score: newScore,
          previousTier: before.leagueTier,
          newTier,
          tierChanged: newTier !== before.leagueTier,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        this.logger.warn(
          `applyBuildingScoreDelta: BuildingScore for building ${buildingId} disappeared ` +
            `mid-transaction (reason=${reason}) — a real Building/BuildingScore row is never ` +
            'deleted in production, so this is a concurrent test-cleanup race, not a ' +
            'data-integrity issue; safely skipping.',
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * 21_ADRs > ADR-041 — looks up an XpTransaction by its polymorphic
   * reference (e.g. `('PAYMENT', paymentId)`), optionally narrowed to a
   * specific `reason`. Used both to find the original CHARGE_PAID award
   * being clawed back, and to check whether a CHARGE_PAID_REVERSED row
   * already exists for that same reference (idempotency guard).
   */
  findXpTransactionByReference(referenceType: string, referenceId: string, reason?: XpReason) {
    return this.prisma.xpTransaction.findFirst({
      where: { referenceType, referenceId, ...(reason ? { reason } : {}) },
    });
  }

  getPersonProgress(personId: string) {
    return this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        xpBalance: true,
        achievements: { include: { definition: true }, orderBy: { unlockedAt: 'desc' } },
      },
    });
  }

  listXpHistory(personId: string) {
    return this.prisma.xpTransaction.findMany({
      where: { personId },
      orderBy: { createdAt: 'desc' },
    });
  }

  getBuildingScore(buildingId: string) {
    return this.prisma.buildingScore.findUnique({ where: { buildingId } });
  }

  listLeaderboard(tier?: LeagueTier) {
    return this.prisma.buildingScore.findMany({
      where: tier ? { leagueTier: tier } : undefined,
      include: { building: { select: { id: true, name: true, city: true } } },
      orderBy: { score: 'desc' },
      take: 50,
    });
  }

  /**
   * 21_ADRs > ADR-047 — "XP Distribution," one of 15_Gamification's own
   * named Analytics metrics. Same `groupBy` + optional date-range shape as
   * `AuditService.getMetrics` (ADR-034). Includes every `XpReason`,
   * including the negative `CHARGE_PAID_REVERSED` clawback rows (ADR-041)
   * — an honest gross view, not netted, since 15_Gamification doesn't
   * specify one way or the other.
   */
  getXpDistribution(fromDate?: Date, toDate?: Date) {
    const where = fromDate || toDate ? { createdAt: { gte: fromDate, lte: toDate } } : undefined;
    return this.prisma.xpTransaction.groupBy({
      by: ['reason'],
      where,
      _sum: { amount: true },
      _count: { reason: true },
      orderBy: { _count: { reason: 'desc' } },
    });
  }

  /** 21_ADRs > ADR-047 — "League Progress": how many buildings currently sit in each `LeagueTier`. */
  getLeagueDistribution() {
    return this.prisma.buildingScore.groupBy({
      by: ['leagueTier'],
      _count: { leagueTier: true },
    });
  }

  /**
   * 21_ADRs > ADR-047 — "Weekly Participation," read literally as "how
   * many distinct people earned at least one XpTransaction since `since`."
   * `groupBy(['personId'])`'s row count IS the distinct-person count — no
   * separate `distinct` query needed.
   */
  async countActiveParticipantsSince(since: Date): Promise<number> {
    const rows = await this.prisma.xpTransaction.groupBy({
      by: ['personId'],
      where: { createdAt: { gte: since } },
    });
    return rows.length;
  }
}
