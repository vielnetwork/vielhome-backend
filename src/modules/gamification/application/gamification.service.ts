import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LeagueTier } from '@prisma/client';
import type { AchievementCode, XpReason } from '@prisma/client';
import { GamificationRepository } from '../infrastructure/repositories/gamification.repository';
import { GamificationPolicy } from '../domain/policies/gamification.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  DuplicateError,
  NotFoundAppError,
  UnexpectedAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
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
  // can find it again. 21_ADRs > ADR-123 — also now the durable
  // idempotency key for `awardXp` itself (see `XpTransaction`'s own
  // `@@unique([referenceType, referenceId, reason])` schema comment).
  // Optional — CHARGE_PAID/CHARGE_PAID_REVERSED and (as of ADR-123)
  // CASE_RESOLVED set these; the other three XpReason values still don't
  // (see that unique index's comment for why that's safe).
  referenceType?: string;
  referenceId?: string;
}

const VALID_LEAGUE_TIERS = new Set<string>(Object.values(LeagueTier));

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
export class GamificationService implements OnModuleInit {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    private readonly gamification: GamificationRepository,
    private readonly policy: GamificationPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * 21_ADRs > ADR-123 — proactive achievement-seed-integrity check, run
   * once at boot. Deliberately logs and continues rather than throwing:
   * a missing seed degrades achievement-unlocking only (XP awarding is
   * unaffected — see `GamificationRepository.unlockAchievement`'s own doc
   * comment), so it doesn't meet this codebase's existing "refuse to
   * boot" bar (`main.ts`'s `CORS_ORIGINS` check is reserved for a genuine
   * security gap, not a soft data-completeness one).
   */
  async onModuleInit(): Promise<void> {
    const missing = await this.gamification.findMissingAchievementCodes();
    if (missing.length > 0) {
      this.logger.error(
        `Gamification achievement seed is incomplete — no AchievementDefinition row exists for: ` +
          `${missing.join(', ')}. Run 'prisma/seed.ts' (or an equivalent seed of ` +
          `ACHIEVEMENT_SEED_DATA) in this environment. XP awarding is unaffected; achievement ` +
          'unlocking for these codes will silently no-op until this is fixed (ADR-123).',
      );
    }
  }

  /**
   * 21_ADRs > ADR-123 — when `input.referenceType`/`referenceId` are set
   * (CHARGE_PAID, CHARGE_PAID_REVERSED, and now CASE_RESOLVED), a repeat
   * call for the same reference+reason is caught by the repository's own
   * DB-level uniqueness guarantee and returned here as a clean, logged
   * no-op: no XpAwarded event, no audit record, no achievement/Building
   * Score side effect fires a second time. This is what makes event
   * replay — concretely, a Case being reopened and resolved again — safe
   * by construction rather than by a best-effort pre-check.
   */
  async awardXp(input: AwardXpInput): Promise<void> {
    const catalogEntry = XP_CATALOG[input.reason];

    const result = await this.gamification.awardXp({
      personId: input.personId,
      buildingId: input.buildingId,
      reason: input.reason,
      amount: catalogEntry.amount,
      sourceEvent: input.sourceEvent,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    });

    if (!result.awarded) return;
    const { newBalance, isFirstOccurrence } = result;

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
   * clawback already happened for it. The `alreadyClawedBack` read below
   * is a cheap early exit for the common case (the two callers —
   * PaymentReversed/PaymentRefunded — are already mutually exclusive
   * terminal states per `PaymentPolicy`, so this should never actually
   * fire twice in practice), not the correctness guarantee itself: 21_ADRs
   * > ADR-123 made `awardXp` itself idempotent against a duplicate
   * `('PAYMENT', paymentId, 'CHARGE_PAID_REVERSED')` via the DB-level
   * `@@unique` constraint, so even a genuine concurrent double-clawback
   * attempt (both requests racing past this read before either writes)
   * can no longer double-apply — the second attempt's `awardXp` call
   * below resolves to a clean, logged no-op instead.
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

  /**
   * 21_ADRs > ADR-124 — Backoffice manual XP correction (item 4A). Adds
   * or subtracts an arbitrary, staff-specified `amount` — deliberately
   * bypasses `XP_CATALOG` entirely (unlike `awardXp`, whose whole point
   * is looking a *fixed* amount up for a *gameplay* reason) and calls the
   * repository's `awardXp` directly with the dedicated `ADMIN_CORRECTION`
   * reason. `referenceType`/`referenceId` are left unset on purpose — see
   * `XpTransaction`'s own schema comment on why ADMIN_CORRECTION must
   * never be reference-constrained the way gameplay awards are: staff may
   * legitimately issue more than one correction for the same person over
   * time, and each one is its own, independent, always-successful ledger
   * row (the repository's `{awarded: false}` duplicate-suppression path
   * is structurally unreachable here, since NULL references never
   * collide with each other under the Phase 1 unique index — this is not
   * a race that "shouldn't happen in practice," it is a race that cannot
   * happen by construction).
   *
   * Deliberately does NOT unlock achievements, apply a Building Score
   * delta, or emit the gameplay `XpAwarded` event (which drives the
   * "you earned XP" notification) — an admin correction is a ledger/
   * balance fix, not a simulated gameplay moment, and firing that
   * notification for what might be a *negative* correction would be
   * actively misleading. The correction's own audit record (`reason:
   * dto.reason`, on `AuditLog`'s first-class `reason` column, not buried
   * in `metadata`) is this action's auditability, per ADR-124's own
   * Decision section.
   */
  async adjustXp(params: {
    personId: string;
    buildingId?: string;
    amount: number;
    reason: string;
    actorPersonId: string;
    requestId?: string;
  }): Promise<{ newBalance: number }> {
    const result = await this.gamification.awardXp({
      personId: params.personId,
      buildingId: params.buildingId,
      reason: 'ADMIN_CORRECTION',
      amount: params.amount,
      sourceEvent: 'GamificationAdministrationService.adjustXp',
    });
    // Structurally unreachable (see doc comment above) — ADMIN_CORRECTION
    // never sets referenceType/referenceId, so the unique index this
    // could only fail against never applies to it. Guarded anyway rather
    // than asserted, so a future schema change that narrows this
    // assumption fails loudly instead of silently returning a stale
    // balance.
    if (!result.awarded) {
      throw new UnexpectedAppError(
        'ADMIN_CORRECTION award unexpectedly suppressed as a duplicate — this should be ' +
          'structurally impossible (ADMIN_CORRECTION never sets referenceType/referenceId).',
      );
    }

    await this.audit.record({
      actorId: params.actorPersonId,
      buildingId: params.buildingId,
      action: 'XpAdjustedByAdmin',
      entityType: 'Person',
      entityId: params.personId,
      reason: params.reason,
      metadata: { amount: params.amount, newBalance: result.newBalance },
      requestId: params.requestId,
    });

    return { newBalance: result.newBalance };
  }

  /**
   * 21_ADRs > ADR-124 — Backoffice manual Building Score correction (item
   * 4B). Reuses the private `applyBuildingScoreDelta` below end-to-end —
   * the exact same league-recalculation + `BuildingScoreEvent` history
   * row + `BuildingScoreChanged`/`LeagueTierChanged` event emission and
   * tier-change audit record a gameplay-driven delta already gets, so a
   * correction that crosses a league boundary is indistinguishable
   * downstream from a gameplay one (Notifications, in particular, should
   * treat "the building was promoted" the same way regardless of why).
   * Adds one more audit record on top — the correction itself (`reason:
   * dto.reason`, `metadata: { delta }`), which the shared helper has no
   * reason to know about (a gameplay delta has no human actor or
   * free-text reason).
   */
  async adjustBuildingScore(params: {
    buildingId: string;
    delta: number;
    reason: string;
    actorPersonId: string;
    requestId?: string;
  }): Promise<void> {
    await this.audit.record({
      actorId: params.actorPersonId,
      buildingId: params.buildingId,
      action: 'BuildingScoreAdjustedByAdmin',
      entityType: 'Building',
      entityId: params.buildingId,
      reason: params.reason,
      metadata: { delta: params.delta },
      requestId: params.requestId,
    });
    await this.applyBuildingScoreDelta(
      params.buildingId,
      params.delta,
      'ADMIN_CORRECTION',
      'GamificationAdministrationService.adjustBuildingScore',
    );
  }

  /**
   * 21_ADRs > ADR-124 — Backoffice manual achievement grant (item 4C).
   * Reuses `unlockAchievement` directly (now revoke-aware — see its own
   * doc comment) rather than duplicating its definition-lookup/atomicity
   * logic. Throws `DuplicateError` (409) if the person already actively
   * holds this achievement, matching this codebase's existing "already
   * happened" convention (`VotingService`'s "already voted",
   * `FinanceService`'s "late fee already applied") rather than silently
   * no-op-ing the way the gameplay path does — a staff-initiated grant
   * that does nothing should tell the staff member that, not look
   * successful.
   */
  async grantAchievement(params: {
    personId: string;
    code: AchievementCode;
    buildingId?: string;
    reason: string;
    actorPersonId: string;
    requestId?: string;
  }): Promise<{ title: string }> {
    const unlocked = await this.gamification.unlockAchievement(
      params.personId,
      params.code,
      params.buildingId,
    );
    if (!unlocked) {
      throw new DuplicateError('This person already holds this achievement.');
    }

    await this.audit.record({
      actorId: params.actorPersonId,
      buildingId: params.buildingId,
      action: 'AchievementGrantedByAdmin',
      entityType: 'Person',
      entityId: params.personId,
      reason: params.reason,
      metadata: { code: params.code },
      requestId: params.requestId,
    });
    return unlocked;
  }

  /**
   * 21_ADRs > ADR-124 — Backoffice manual achievement revoke (item 4C).
   * Throws `NotFoundAppError` (404) when the person does not currently
   * hold this achievement — same "nothing active to act on" shape
   * `RbacManagementService.revokeRole`'s own "Active role grant not
   * found" already established for this codebase's other revocable-row
   * domain. Never deletes the `PersonAchievement` row (see its own schema
   * comment) — this only closes it out via `revokedAt`/`revokedById`,
   * fully explicit in both the row itself and this audit record.
   */
  async revokeAchievement(params: {
    personId: string;
    code: AchievementCode;
    reason: string;
    actorPersonId: string;
    requestId?: string;
  }): Promise<{ title: string }> {
    const revoked = await this.gamification.revokeAchievement(
      params.personId,
      params.code,
      params.actorPersonId,
    );
    if (!revoked) {
      throw new NotFoundAppError('This person does not currently hold this achievement.');
    }

    await this.audit.record({
      actorId: params.actorPersonId,
      action: 'AchievementRevokedByAdmin',
      entityType: 'Person',
      entityId: params.personId,
      reason: params.reason,
      metadata: { code: params.code },
      requestId: params.requestId,
    });
    return revoked;
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

  /**
   * 21_ADRs > ADR-124 — paginated (was unbounded — see
   * `GamificationRepository.listXpHistory`'s own doc comment). `reason`
   * is validated at the controller via `ParseEnumPipe(XpReason, {
   * optional: true })` (the same per-param enum-pipe convention
   * `CasesController.listCases` already uses for `type`/`status`/
   * `priority`), so it always arrives here as either `undefined` or a
   * real `XpReason` — no re-validation needed. `fromDate`/`toDate` are
   * validated here, mirroring `getAnalytics`'s own identically-shaped
   * check immediately below (the closest existing precedent for this
   * exact validation, not a new pattern). Strictly own-scoped: `personId`
   * always comes from the caller's own JWT (`GamificationController.
   * getMyXpHistory`), never a path/query param — there is no way to
   * request another person's XP history through this method.
   */
  async getMyXpHistory(
    personId: string,
    filter: { reason?: XpReason; fromDate?: Date; toDate?: Date },
    pagination: PaginationParams,
  ) {
    if (filter.fromDate && Number.isNaN(filter.fromDate.getTime())) {
      throw new ValidationError('Invalid fromDate.');
    }
    if (filter.toDate && Number.isNaN(filter.toDate.getTime())) {
      throw new ValidationError('Invalid toDate.');
    }
    if (
      filter.fromDate &&
      filter.toDate &&
      filter.fromDate.getTime() > filter.toDate.getTime()
    ) {
      throw new ValidationError('fromDate must not be after toDate.');
    }

    const { items, total } = await this.gamification.listXpHistory(
      personId,
      filter,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async getBuildingScore(buildingId: string) {
    const score = await this.gamification.getBuildingScore(buildingId);
    // A building with no gamification activity yet has no BuildingScore
    // row — report it as BRONZE/0 rather than 404, since "no activity
    // yet" is a valid, expected state, not an error.
    return score ?? { buildingId, score: 0, leagueTier: 'BRONZE' as LeagueTier, updatedAt: null };
  }

  /**
   * 21_ADRs > ADR-123 — `tier`, if present, must be a real `LeagueTier`
   * value. An invalid value is now a clean `ValidationError` (400)
   * instead of silently reaching Prisma's `where` clause, which would
   * just never match any row and return an empty (but 200 OK) list.
   *
   * 21_ADRs > ADR-124 — paginated (was a hardcoded top-50 — see
   * `GamificationRepository.listLeaderboard`'s own doc comment for the
   * tie-breaker rationale). `tier` validation unchanged from ADR-123. No
   * building-name/search filter — deliberately not added; see ADR-124's
   * own Decision section for why (no indexed text-search column, and no
   * clear product need beyond `tier`, which this MVP's own "buildings
   * compete in leagues" framing already centers on).
   */
  getLeaderboard(tier: string | undefined, pagination: PaginationParams) {
    if (tier !== undefined && !VALID_LEAGUE_TIERS.has(tier)) {
      throw new ValidationError(
        `Invalid tier: "${tier}". Must be one of: ${Object.values(LeagueTier).join(', ')}.`,
      );
    }
    return this.gamification
      .listLeaderboard(tier as LeagueTier | undefined, toSkipTake(pagination))
      .then(({ items, total }) => ({ items, meta: buildPaginationMeta(pagination, total) }));
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
   *
   * 21_ADRs > ADR-123 — `fromDate`/`toDate`, now validated the same way
   * `AnalyticsService.resolveRange` already validates its own identically
   * shaped params (the closest existing precedent in this codebase for
   * this exact check, and itself a consumer of this very method): an
   * unparseable date string reaching here as `Invalid Date`, or
   * `fromDate` after `toDate`, is now a clean `ValidationError` (400)
   * instead of silently reaching Prisma as `Invalid Date` (which Prisma
   * would otherwise just treat as a non-matching filter, not an error).
   */
  async getAnalytics(fromDate?: Date, toDate?: Date) {
    if (fromDate && Number.isNaN(fromDate.getTime())) {
      throw new ValidationError('Invalid fromDate.');
    }
    if (toDate && Number.isNaN(toDate.getTime())) {
      throw new ValidationError('Invalid toDate.');
    }
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new ValidationError('fromDate must not be after toDate.');
    }

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
