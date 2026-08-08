import { Injectable, Logger } from '@nestjs/common';
import { AchievementCode, Prisma } from '@prisma/client';
import type { LeagueTier, XpReason } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { GamificationPolicy } from '../../domain/policies/gamification.policy';

/**
 * 21_ADRs > ADR-123 — the same "defensive backstop against a real
 * `@@unique(...)` racing a concurrent duplicate" pattern already used by
 * `FinanceService`/`VotingService` (their own local, identically-named
 * `isUniqueConstraintViolation` helpers) — converts Prisma's raw `P2002`
 * into a typed, deterministic signal instead of letting it surface as an
 * unhandled 500 or crash an event listener.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export type AwardXpResult =
  | { awarded: true; newBalance: number; isFirstOccurrence: boolean }
  // 21_ADRs > ADR-123 — the `XpTransaction` model's own
  // `@@unique([referenceType, referenceId, reason])` index rejected this
  // attempt as a duplicate of an already-recorded award for the same
  // reference+reason. Deliberately not an error: `GamificationService.
  // awardXp` treats this as a clean, logged no-op — exactly how a
  // legitimate retried/replayed event, or (concretely) a Case being
  // reopened and resolved again, should behave.
  | { awarded: false };

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
   *
   * 21_ADRs > ADR-123 — when `referenceType`/`referenceId` are set, this
   * is now also the durable idempotency guarantee for that award: the
   * `XpTransaction` model's `@@unique([referenceType, referenceId,
   * reason])` index (see schema.prisma's own comment) means a second
   * attempt to award the same reason for the same reference can only
   * ever reach the `catch` below, never create a second row — true under
   * real concurrency/event-replay, not just a best-effort
   * read-before-write pre-check. Returns `{ awarded: false }` rather than
   * throwing, so a duplicate attempt is a clean, deterministic no-op for
   * the caller.
   */
  async awardXp(params: {
    personId: string;
    buildingId?: string;
    reason: XpReason;
    amount: number;
    sourceEvent?: string;
    referenceType?: string;
    referenceId?: string;
  }): Promise<AwardXpResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
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

        return {
          awarded: true as const,
          newBalance: person.xpBalance,
          isFirstOccurrence: priorCount === 0,
        };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        this.logger.warn(
          `awardXp: duplicate award suppressed — an XpTransaction already exists for ` +
            `reason=${params.reason} referenceType=${params.referenceType ?? 'null'} ` +
            `referenceId=${params.referenceId ?? 'null'}. No XP/Building Score/event fired for ` +
            'this attempt (idempotency guard, ADR-123).',
        );
        return { awarded: false };
      }
      throw error;
    }
  }

  /**
   * Idempotent — returns `null` if the person already has this
   * achievement (achievements are permanent, never re-unlocked).
   *
   * 21_ADRs > ADR-123 — if `code` has no seeded `AchievementDefinition`
   * yet (see `prisma/seed.ts`), XP still awards — this still returns
   * `null` rather than throwing, preserving the pre-existing "XP
   * awarding stays resilient to a missing achievement seed" policy — but
   * the gap is no longer silent: this now logs a structured `error`-level
   * line every time it happens, so a forgotten seed step becomes
   * observable instead of invisible. See `GamificationService.
   * onModuleInit` for the proactive half of this same fix (a boot-time
   * check across every `AchievementCode`, not just the ones actually
   * triggered at runtime).
   */
  async unlockAchievement(
    personId: string,
    code: AchievementCode,
    buildingId?: string,
  ): Promise<{ title: string } | null> {
    const definition = await this.prisma.achievementDefinition.findUnique({ where: { code } });
    if (!definition) {
      this.logger.error(
        `unlockAchievement: no AchievementDefinition seeded for code=${code} — XP still awarded ` +
          `(by design), but this achievement will never unlock for anyone in this environment ` +
          `until 'prisma/seed.ts' (or an equivalent seed of ACHIEVEMENT_SEED_DATA) is run. This ` +
          'is a missing-seed operational gap, not a code defect (ADR-123).',
      );
      return null;
    }

    const existing = await this.prisma.personAchievement.findUnique({
      where: { personId_definitionId: { personId, definitionId: definition.id } },
    });
    if (existing) return null;

    // 21_ADRs > ADR-123 — the achievement row and its (possibly non-zero)
    // XP bonus balance increment are now one atomic `$transaction`,
    // closing the latent inconsistency window that previously existed
    // whenever `xpBonus > 0` (safe before this fix only because every
    // seeded achievement's `xpBonus` is 0 today — see `xp-catalog.ts`'s
    // own `ACHIEVEMENT_SEED_DATA`). Deliberately does NOT also write a
    // bonus `XpTransaction` ledger row: doing so would need a new
    // `XpReason` value purely to describe "an achievement's own bonus" —
    // a schema/analytics-surface change this narrowly-scoped hardening
    // pass chose not to make for a path that stays dormant in every
    // environment today. `Person.xpBalance` and the achievement unlock
    // itself are guaranteed consistent with each other by this
    // transaction either way; seeding a non-zero bonus (and, if ever
    // needed, giving it its own ledger entry) remains a future product
    // decision, not something this correctness fix should provoke.
    return this.prisma.$transaction(async (tx) => {
      await tx.personAchievement.create({
        data: { personId, definitionId: definition.id, buildingId },
      });

      if (definition.xpBonus > 0) {
        await tx.person.update({
          where: { id: personId },
          data: { xpBalance: { increment: definition.xpBonus } },
        });
      }

      return { title: definition.title };
    });
  }

  /**
   * 21_ADRs > ADR-123 — proactive half of the achievement-seed-safety fix
   * (the reactive half is `unlockAchievement`'s own structured error log
   * above). Called once from `GamificationService.onModuleInit`. Compares
   * every `AchievementCode` enum value against the real seeded
   * `AchievementDefinition` rows and returns the codes with no matching
   * row. Deliberately read-only (no seeding/writing happens here — that
   * stays `prisma/seed.ts`'s job) and deliberately never throws: a
   * missing seed must not block application boot any more than it blocks
   * XP awarding.
   */
  async findMissingAchievementCodes(): Promise<AchievementCode[]> {
    const allCodes = Object.values(AchievementCode);
    const seeded = await this.prisma.achievementDefinition.findMany({ select: { code: true } });
    const seededCodes = new Set(seeded.map((row) => row.code));
    return allCodes.filter((code) => !seededCodes.has(code));
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
   * being clawed back, and (21_ADRs > ADR-123) as a cheap early-exit
   * check for whether a CHARGE_PAID_REVERSED row already exists for that
   * same reference — this pre-check is now an optimization only (it
   * avoids attempting a doomed `awardXp` call in the common case); the
   * actual correctness guarantee against a concurrent double-clawback is
   * `XpTransaction`'s own `@@unique([referenceType, referenceId,
   * reason])` index plus `awardXp`'s deterministic `P2002` handling, not
   * this read-before-write check by itself.
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
