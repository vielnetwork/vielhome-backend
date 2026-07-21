import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { LeagueTier, XpReason } from '@prisma/client';
import { GamificationRepository } from '../infrastructure/repositories/gamification.repository';
import { GamificationPolicy } from '../domain/policies/gamification.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { XP_CATALOG } from '../domain/xp-catalog';
import {
  AchievementUnlockedEvent,
  BuildingScoreChangedEvent,
  LeagueTierChangedEvent,
  XpAwardedEvent,
} from '../events/gamification.events';

export interface AwardXpInput {
  personId: string;
  buildingId?: string;
  reason: XpReason;
  sourceEvent?: string;
  // 21_ADRs > ADR-041 — polymorphic reference to the entity this specific
  // award is tied to (e.g. `('PAYMENT', paymentId)`), so a later clawback
  // can find it again. Optional — only CHARGE_PAID sets these today.
  referenceType?: string;
  referenceId?: string;
}

/**
 * The single entry point every domain event listener calls
 * (`GamificationEventListener`) — mirrors `NotificationsService.notify`'s
 * role as the one place that turns "something happened" into gamification
 * state. Looks up the reason in `XP_CATALOG` for the XP amount, Building
 * Score delta, and (optional) achievement code, applies all three, and
 * emits this module's own events so `NotificationEventListener` can
 * celebrate them — completing 15_Gamification's "Business Event ->
 * Gamification Event -> ... -> Notification" pipeline.
 */
@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    private readonly gamification: GamificationRepository,
    private readonly policy: GamificationPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async awardXp(input: AwardXpInput): Promise<void> {
    const catalogEntry = XP_CATALOG[input.reason];

    const { newBalance, isFirstOccurrence } = await this.gamification.awardXp({
      personId: input.personId,
      buildingId: input.buildingId,
      reason: input.reason,
      amount: catalogEntry.amount,
      sourceEvent: input.sourceEvent,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });

    await this.audit.record({
      actorId: input.personId,
      buildingId: input.buildingId,
      action: 'XpAwarded',
      entityType: 'Person',
      entityId: input.personId,
      metadata: { reason: input.reason, amount: catalogEntry.amount, newBalance },
    });

    this.events.emit(
      'XpAwarded',
      new XpAwardedEvent(
        input.personId,
        input.buildingId ?? null,
        input.reason,
        catalogEntry.amount,
        newBalance,
      ),
    );

    if (isFirstOccurrence && catalogEntry.achievementCode) {
      const unlocked = await this.gamification.unlockAchievement(
        input.personId,
        catalogEntry.achievementCode,
        input.buildingId,
      );
      if (unlocked) {
        await this.audit.record({
          actorId: input.personId,
          buildingId: input.buildingId,
          action: 'AchievementUnlocked',
          entityType: 'Person',
          entityId: input.personId,
          metadata: { code: catalogEntry.achievementCode },
        });
        this.events.emit(
          'AchievementUnlocked',
          new AchievementUnlockedEvent(
            input.personId,
            catalogEntry.achievementCode,
            unlocked.title,
            input.buildingId ?? null,
          ),
        );
      }
    }

    if (input.buildingId && catalogEntry.buildingScoreDelta !== 0) {
      await this.applyBuildingScoreDelta(
        input.buildingId,
        catalogEntry.buildingScoreDelta,
        input.reason,
        input.sourceEvent,
      );
    }
  }

  /**
   * 21_ADRs > ADR-041 — claws back the CHARGE_PAID XP (and its Building
   * Score delta) previously awarded for a specific Payment, when that
   * Payment is later reversed or fully refunded. Deliberately narrow
   * (CHARGE_PAID → CHARGE_PAID_REVERSED only), matching this session's own
   * "VerifiedRolesGuard" precedent of scoping a fix to exactly what the
   * source material asks for rather than building a generic N-reason
   * reversal framework nobody asked for — see ADR-041 Decision points for
   * why the other four XpReason values have no reversal path.
   *
   * Reuses `awardXp` end-to-end rather than writing a bespoke negative
   * path: `XP_CATALOG.CHARGE_PAID_REVERSED` already carries the negated
   * amount/buildingScoreDelta and no achievementCode, so the exact same
   * ledger-row + Person.xpBalance + Building Score + event-emission
   * pipeline applies correctly with zero special-casing. The achievement
   * (FIRST_PAYMENT), once unlocked, is never revoked — permanent by
   * `unlockAchievement`'s own idempotency, untouched here.
   *
   * A no-op (not an error) when there's nothing to claw back — either no
   * CHARGE_PAID award exists for this reference (predates this feature,
   * or the payer's XP award failed silently for some other reason) or a
   * clawback already happened for it (defensive idempotency guard; the
   * two callers — PaymentReversed/PaymentRefunded — are already mutually
   * exclusive terminal states per `PaymentPolicy`, so this should never
   * actually fire twice in practice, but costs one extra read to be sure).
   */
  async clawbackChargePaidXp(params: { paymentId: string; sourceEvent?: string }): Promise<void> {
    const original = await this.gamification.findXpTransactionByReference(
      'PAYMENT',
      params.paymentId,
      'CHARGE_PAID',
    );
    if (!original) {
      this.logger.log(
        `clawbackChargePaidXp: no CHARGE_PAID award found for payment ${params.paymentId}, nothing to claw back.`,
      );
      return;
    }

    const alreadyClawedBack = await this.gamification.findXpTransactionByReference(
      'PAYMENT',
      params.paymentId,
      'CHARGE_PAID_REVERSED',
    );
    if (alreadyClawedBack) return;

    await this.awardXp({
      personId: original.personId,
      buildingId: original.buildingId ?? undefined,
      reason: 'CHARGE_PAID_REVERSED',
      sourceEvent: params.sourceEvent,
      referenceType: 'PAYMENT',
      referenceId: params.paymentId,
    });
  }

  private async applyBuildingScoreDelta(
    buildingId: string,
    delta: number,
    reason: string,
    sourceEvent?: string,
  ): Promise<void> {
    const result = await this.gamification.applyBuildingScoreDelta(
      buildingId,
      delta,
      reason,
      sourceEvent,
    );

    // 21_ADRs > ADR-079 round-1 fix — `null` means the repository caught a
    // concurrent-deletion race on this building's BuildingScore row (see
    // its own doc comment); nothing meaningful to emit or audit, safely
    // skip the rest of this side effect rather than throw on `result.score`.
    if (!result) return;

    this.events.emit(
      'BuildingScoreChanged',
      new BuildingScoreChangedEvent(
        buildingId,
        result.score,
        delta,
        result.previousTier,
        result.newTier,
      ),
    );

    if (result.tierChanged) {
      const promoted = this.policy.isPromotion(result.previousTier, result.newTier);
      await this.audit.record({
        buildingId,
        action: 'LeagueTierChanged',
        entityType: 'Building',
        entityId: buildingId,
        metadata: { previousTier: result.previousTier, newTier: result.newTier, promoted },
      });
      this.events.emit(
        'LeagueTierChanged',
        new LeagueTierChangedEvent(buildingId, result.previousTier, result.newTier, promoted),
      );
    }
  }

  getMyProgress(personId: string) {
    return this.gamification.getPersonProgress(personId);
  }

  getMyXpHistory(personId: string) {
    return this.gamification.listXpHistory(personId);
  }

  async getBuildingScore(buildingId: string) {
    const score = await this.gamification.getBuildingScore(buildingId);
    // A building with no gamification activity yet has no BuildingScore
    // row — report it as BRONZE/0 rather than 404, since "no activity
    // yet" is a valid, expected state, not an error.
    return score ?? { buildingId, score: 0, leagueTier: 'BRONZE' as LeagueTier, updatedAt: null };
  }

  getLeaderboard(tier?: LeagueTier) {
    return this.gamification.listLeaderboard(tier);
  }

  /**
   * 21_ADRs > ADR-047 — a bounded slice of 15_Gamification's own "Analytics"
   * section ("Track: Daily Active Users, Weekly Participation, XP
   * Distribution, League Progress, Mission Completion, Retention, Community
   * Health"). Only the three metrics directly and unambiguously computable
   * from data this codebase already records are built: XP Distribution and
   * League Progress (both pure aggregates over existing tables) and Weekly
   * Participation (read literally as distinct XP-earners in the trailing 7
   * days). Deliberately NOT built, and not silently dropped: Daily Active
   * Users (no login/session-activity concept exists to define "active" by,
   * only XP events — building it here would silently redefine DAU as "XP
   * activity," inventing a metric the source doesn't actually describe);
   * Mission Completion (the Daily Missions domain itself doesn't exist —
   * same "infra exists, domain doesn't" gap flagged since ADR-028); Retention
   * and Community Health (neither has any specified formula, window, or
   * threshold anywhere in 15_Gamification — the same "no numeric threshold
   * specified" reason Recovery Mode auto-expiry and Cases/Support SLA stay
   * unwired).
   */
  async getAnalytics(fromDate?: Date, toDate?: Date) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [xpDistribution, leagueDistribution, weeklyActiveParticipants] = await Promise.all([
      this.gamification.getXpDistribution(fromDate, toDate),
      this.gamification.getLeagueDistribution(),
      this.gamification.countActiveParticipantsSince(sevenDaysAgo),
    ]);

    return {
      xpByReason: xpDistribution.map((row) => ({
        reason: row.reason,
        totalAmount: row._sum.amount ?? 0,
        transactionCount: row._count.reason,
      })),
      leagueDistribution: leagueDistribution.map((row) => ({
        tier: row.leagueTier,
        buildingCount: row._count.leagueTier,
      })),
      weeklyActiveParticipants,
    };
  }
}
