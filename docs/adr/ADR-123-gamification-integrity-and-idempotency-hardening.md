# ADR-123: Gamification integrity and idempotency hardening

## Status

Accepted — 2026-08-07

## Context

An implementation audit of the Gamification module (XP ledger, Achievements,
Building Score/League — ADR-028) found one confirmed, exploitable integrity
bug and several smaller, disclosed hardening gaps, all scoped to Phase 1 of a
"Gamification Hardening" pass:

- `GamificationEventListener.onCaseStatusChanged` awarded `CASE_RESOLVED` XP
  (+25) and Building Score (+4) on **every** transition to `RESOLVED`, with no
  guard. Cases' own policy legitimately allows `RESOLVED`/`CLOSED` → reopened
  → `RESOLVED` again (06.07 Rule 014), so a privileged member could repeatedly
  reopen and resolve the same case to mint unlimited XP/Building Score. This
  was directly reachable — `test/cases.e2e-spec.ts`'s own pre-existing
  "Status Lifecycle & Gamification XP" describe block already resolved the
  same case twice (once directly, once via close → reopen → resolve) to test
  Cases' own reopen-authorization rule, without ever asserting Gamification
  stayed idempotent across it.
- `clawbackChargePaidXp`'s duplicate-clawback guard was a read-before-write
  check only (`findXpTransactionByReference` for an existing
  `CHARGE_PAID_REVERSED` row), not a database-level guarantee — a genuine
  TOCTOU race under real concurrency, previously accepted as low-risk because
  `PaymentReversed`/`PaymentRefunded` are mutually exclusive terminal payment
  states.
- `GamificationRepository.unlockAchievement`'s achievement-row-create and
  (when `xpBonus > 0`) `Person.xpBalance` bonus increment were two separate,
  non-atomic writes — safe only because every seeded achievement's `xpBonus`
  is `0` today.
- `unlockAchievement` silently no-ops (by design) when an `AchievementCode`
  has no seeded `AchievementDefinition` row, with no observability if that
  ever happens in a real environment (e.g. a forgotten `prisma/seed.ts` run).
- `GET /gamification/leaderboard`'s `tier` and `GET /gamification/analytics`'s
  `fromDate`/`toDate` accepted unvalidated strings — an invalid tier silently
  matched zero leaderboard rows (200 OK, empty list) instead of a clean 400,
  and an unparseable date string reached Prisma as `Invalid Date`.
- `GamificationService`, `GamificationRepository`, `GamificationEventListener`,
  and `XP_CATALOG`/`ACHIEVEMENT_SEED_DATA` had zero dedicated unit test
  coverage (only `GamificationPolicy` did) — everything else was proven only
  by the (real, but DB-dependent) e2e suite.

## Decision

- **CASE_RESOLVED duplicate-XP**: `onCaseStatusChanged` now attaches
  `referenceType: 'CASE', referenceId: event.caseId` to its `awardXp` call,
  exactly the same polymorphic-reference shape `CHARGE_PAID` already used
  (ADR-041). No new "resolution episode" concept was invented — a Case's
  `CASE_RESOLVED` award collapses to "at most one per case, ever," matching
  the only policy any available source document actually describes.
- **Durable idempotency, not a read-before-write check**: `XpTransaction`
  gains `@@unique([referenceType, referenceId, reason])` (replacing the old
  plain `(referenceType, referenceId)` index). This is safe for every
  currently-defined `XpReason` without narrowing to a per-reason exception
  list: `PROFILE_CREATED`/`BUILDING_SETUP_COMPLETED`/`VOTE_PARTICIPATED`
  never populate `referenceType`/`referenceId`, and Postgres treats every
  `NULL` as distinct from every other `NULL` in a unique index, so the
  constraint is a guaranteed no-op for those rows — their existing
  single-fire guarantees (enforced by their own source domains, e.g.
  Governance's one-ballot-per-unit rule) are untouched.
  `CHARGE_PAID`/`CHARGE_PAID_REVERSED` were already one-award-per-payment;
  `CASE_RESOLVED` is now one-award-per-case for the same reason. A globally
  unqualified `(referenceType, referenceId, reason)` uniqueness rule was
  deliberately NOT applied blindly — it was verified reason-by-reason first,
  per the above.
- **Deterministic conflict handling**: `GamificationRepository.awardXp`
  catches the resulting `P2002` (same `isUniqueConstraintViolation` pattern
  already used by `FinanceService`/`VotingService`) and returns
  `{ awarded: false }` instead of throwing. `GamificationService.awardXp`
  treats this as a clean, logged no-op: no `XpTransaction`, no
  `Person.xpBalance` change, no audit record, no `XpAwarded`/
  `AchievementUnlocked`/`LeagueTierChanged` event. This makes event replay —
  concretely, a Case being reopened and resolved again — safe by
  construction, not by a best-effort pre-check. The Finance clawback's
  existing pre-check stays as a cheap early-exit optimization; the unique
  constraint plus this handling is now the actual correctness guarantee for
  it too.
- **Achievement bonus atomicity**: `unlockAchievement`'s `PersonAchievement`
  create and (when `xpBonus > 0`) `Person.xpBalance` increment now run inside
  one `$transaction`. Deliberately does NOT add a new `XpReason` value to
  give the bonus its own ledger row — that would be a schema/analytics
  surface change for a path that stays dormant in every environment today
  (every seeded `xpBonus` is `0`); the atomicity fix alone closes the
  concrete "could leave things inconsistent" risk this phase was scoped to.
- **Achievement seed observability**: `unlockAchievement`'s missing-definition
  branch now logs a structured `error`-level line (previously silent).
  `GamificationService.onModuleInit` adds a new proactive boot-time check
  (`GamificationRepository.findMissingAchievementCodes`) that compares every
  `AchievementCode` against seeded rows and logs an `error` naming any gaps.
  Neither blocks application boot nor blocks XP awarding — a missing seed
  degrades achievement-unlocking only, which does not meet this codebase's
  existing "refuse to boot" bar (`main.ts`'s `CORS_ORIGINS` check, reserved
  for a genuine security gap).
- **Query validation**: `GamificationService.getLeaderboard` validates `tier`
  against the real `LeagueTier` enum; `GamificationService.getAnalytics`
  validates `fromDate`/`toDate` for parseability and range order
  (`fromDate <= toDate`). Both throw `ValidationError` (400,
  `VALIDATION_ERROR`) — the existing platform error taxonomy, not a new
  mechanism. Deliberately implemented as manual service-layer validation
  (mirroring `AnalyticsService.resolveRange`'s own identical-shaped check,
  the closest existing precedent, and itself a consumer of
  `GamificationService.getAnalytics`) rather than a bound `@Query() dto:`
  class — this codebase has no existing GET-query DTO precedent anywhere,
  and `pagination.util.ts`'s own doc comment documents a real, specific
  reason individual `@Query('x')` params are used platform-wide instead
  (`ValidationPipe`'s `forbidNonWhitelisted: true` rejects a whole-object
  `@Query()` DTO's sibling raw query keys). No pagination was added — out of
  this phase's explicit scope.
- **Unit tests**: added `gamification.service.spec.ts`,
  `gamification.repository.spec.ts`, `gamification-event-listener.service.
  spec.ts`, and `xp-catalog.spec.ts`, covering award amounts/Building Score
  deltas/achievement mapping, the new idempotency short-circuit, clawback
  behavior (including partial-refund non-clawback, a listener-level
  decision), league promotion, the missing-achievement-definition path, the
  non-zero-bonus transactional path, and CASE_RESOLVED duplicate protection
  at both the listener and repository layers.

## Consequences

One migration
(`20260807233000_gamification_reference_award_idempotency`) drops the old
`xp_transactions_referenceType_referenceId_idx` index and replaces it with
the unique `xp_transactions_referenceType_referenceId_reason_key` index. This
does not delete, merge, or rewrite any existing `XpTransaction` row — doing
so would violate this codebase's append-only-ledger convention. If a given
environment already has duplicate `(referenceType, referenceId, reason)` rows
(only plausible for `CASE_RESOLVED`, the confirmed gap; `CHARGE_PAID`/
`CHARGE_PAID_REVERSED` already had an application-level guard), the migration
will fail with a clear Postgres duplicate-key error rather than silently
discarding ledger history — a human reconciliation decision is required
there before it can be applied. No API response contract changed. Reputation,
Daily Missions, Seasonal Events, Rewards, Streaks, person-level ranking, new
UX, Backoffice XP/achievement correction tooling, and pagination remain
explicitly out of scope for this phase.
