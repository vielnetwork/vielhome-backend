import { Injectable } from '@nestjs/common';
import type { AchievementCode, LeagueTier, XpReason } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { GamificationPolicy } from '../../domain/policies/gamification.policy';

@Injectable()
export class GamificationRepository {
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
   */
  async applyBuildingScoreDelta(
    buildingId: string,
    delta: number,
    reason: string,
    sourceEvent?: string,
  ): Promise<{ score: number; previousTier: LeagueTier; newTier: LeagueTier; tierChanged: boolean }> {
    return this.prisma.$transaction(async (tx) => {
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
