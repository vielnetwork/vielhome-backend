# ADR-124: Gamification Hardening Phase 2 — Scale & Operations

## Status

Accepted — 2026-08-08

## Context

`ADR-123` (Gamification Hardening Phase 1) closed a confirmed duplicate-XP
integrity bug and added dedicated unit coverage, but explicitly left
pagination and Backoffice correction tooling out of scope. A follow-up
production-hardening pass ("Phase 2: Scale + Operations") found the
following, still scoped to making the existing MVP operationally safe, not a
redesign:

- `GET /gamification/me/xp-history` returned every `XpTransaction` row for
  the caller, unbounded — a person with years of activity would eventually
  make this endpoint (and its underlying `findMany`) slow, and there was no
  way to page through, filter by `reason`, or narrow by date range.
- `GET /gamification/leaderboard` used a hardcoded `.take(50)` with no
  secondary sort key — buildings ranked 51st and below were silently
  unreachable through the API, and two same-score buildings had no
  guaranteed relative order across requests (a real risk once more than a
  handful of buildings share a score, which happens constantly at the
  shared starting value of 0).
- There was no way for Backoffice staff to correct a mistaken or
  out-of-band XP award, Building Score, or achievement grant without a
  direct, unaudited database write — a real operational gap once the
  product is live (support tickets like "the case-resolution bonus never
  landed" or "this achievement was granted by a test script in
  production" have no sanctioned fix path).
- `PersonAchievement` had a plain `@@unique([personId, definitionId])`
  constraint — permanent by construction, with no way to revoke a
  wrongly-granted achievement without either leaving it in place forever or
  hard-deleting history, both unacceptable under this codebase's
  "History Never Changes" convention (the same convention `StaffRole`/
  `RolePermission` already solved with a partial unique index).

## Decision

- **XP history pagination**: `GamificationRepository.listXpHistory` and
  `GamificationService.getMyXpHistory` now accept `page`/`limit` (the
  existing shared `pagination.util.ts` primitives — `parsePagination`,
  `toSkipTake`, `buildPaginationMeta`, `DEFAULT_PAGE_LIMIT=20`,
  `MAX_PAGE_LIMIT=100` — same utility every other paginated list endpoint in
  this codebase already uses) plus optional `reason` (validated via
  `ParseEnumPipe(XpReason, { optional: true })` at the controller, the same
  per-param enum-pipe convention `CasesController.listCases` established for
  `type`/`status`/`priority`) and `fromDate`/`toDate` (validated in the
  service, mirroring `getAnalytics`'s own pre-existing identical check).
  Ordering is `createdAt desc, id desc` — the same deterministic
  primary-plus-tie-breaker shape `CaseRepository.listCases` established,
  needed because two `XpTransaction` rows can share a `createdAt`
  millisecond under real load (e.g. a bulk admin-correction pass). No
  free-text search was added — there is no field on `XpTransaction` a
  free-text search would meaningfully match beyond the now-enum-filterable
  `reason`. Strictly own-scoped throughout: `personId` always comes from the
  caller's JWT, never a query/path parameter.
- **Leaderboard pagination**: `GamificationRepository.listLeaderboard` and
  `GamificationService.getLeaderboard` are paginated the same way, ordering
  `score desc, id asc` (deterministic tie-breaker, same reasoning as XP
  history — many buildings share a score, most obviously at the starting
  value of 0). The pre-existing `tier` filter and ADR-123's own tier
  validation are unchanged. Cross-building visibility (every authenticated
  caller sees every building — ADR-028's own deliberate choice) is
  unchanged; this only bounds and pages the response shape, closing the
  "buildings ranked 51st+ are silently unreachable" gap. **No
  building-name/free-text search filter was added, deliberately**:
  `Building.name` has no indexed text-search column, so a `contains`/ILIKE
  filter would be an unindexed scan on a table this pass just made
  page-scalable, and no source document names a search requirement beyond
  `tier` — 15_Gamification's own "buildings compete in leagues" framing
  already centers the leaderboard on tier, not free-text lookup. Adding one
  merely to increase feature count would trade a real performance
  regression for a speculative feature no requirement asked for.
- **Backoffice Gamification correction tooling**: four new routes on a new
  `GamificationAdministrationController`
  (`POST /backoffice/gamification/persons/:personId/xp`,
  `.../buildings/:buildingId/score`,
  `.../persons/:personId/achievements/grant`,
  `.../persons/:personId/achievements/revoke`), each requiring a mandatory,
  minimum-length `reason` (DTO-validated) and gated
  `SENIOR_REVIEWER`+ + a new `GAMIFICATION_CORRECTION_MANAGE` permission —
  the same "consequential, entity-affecting staff action" bar
  `FinanceAdministrationController.reverse`/`refund` already set, one level
  above the `REVIEWER` + `GAMIFICATION_ANALYTICS_VIEW` bar the pre-existing
  read-only `analytics` route uses.
  - `adjustXp` calls the repository's `awardXp` directly with a new,
    dedicated `ADMIN_CORRECTION` `XpReason` — deliberately bypassing
    `XP_CATALOG` (unlike gameplay `awardXp`, which looks up a *fixed*
    amount for a *gameplay* reason, a staff correction is an arbitrary
    signed amount the DTO itself carries). It does **not** unlock
    achievements, apply a Building Score delta, or emit the gameplay
    `XpAwarded` event — a correction is a ledger/balance fix, not a
    simulated gameplay moment, and firing "you earned XP!" for what might
    be a negative correction would be actively misleading.
  - `adjustBuildingScore` reuses the existing private
    `applyBuildingScoreDelta` end-to-end — the exact same league
    recalculation, `BuildingScoreEvent` history row, and
    `BuildingScoreChanged`/`LeagueTierChanged` event emission (plus its own
    tier-change audit record) a gameplay-driven delta already gets, so a
    correction that crosses a league boundary is indistinguishable
    downstream from a gameplay-caused one.
  - `grantAchievement`/`revokeAchievement` reuse
    `unlockAchievement`/(new) `revokeAchievement` on the repository.
    `grantAchievement` throws `DuplicateError` (409) if the person already
    actively holds the achievement — matching this codebase's "already
    happened" convention (`VotingService`'s "already voted") rather than
    silently no-op-ing the way the gameplay path does, since a
    staff-initiated action that does nothing should say so.
    `revokeAchievement` throws `NotFoundAppError` (404) when there is
    nothing active to revoke, matching `RbacManagementService.revokeRole`'s
    own "Active role grant not found" shape.
  - Every one of the four records a real `AuditLog` row via the existing
    `AuditService.record` (actor, entity, action, the human `reason` on its
    own first-class column, and relevant metadata) — not just an
    application log line. This is this feature's actual auditability
    requirement; nothing here relies on log aggregation.
  - **Admin corrections never collide with the Phase 1 idempotency
    guarantee, by construction, not by convention**: `ADMIN_CORRECTION`
    never sets `referenceType`/`referenceId`, reusing the exact "NULL is
    always distinct from NULL in a unique index" mechanism ADR-123 already
    established for `PROFILE_CREATED`/`BUILDING_SETUP_COMPLETED`/
    `VOTE_PARTICIPATED`. Staff may legitimately issue more than one
    correction for the same person over time — each is independently
    successful, never suppressed as a "duplicate" gameplay award.
  - `GamificationAdministrationController`/`...Service` live inside the
    `gamification` module's own file tree, not `backoffice/`, even though
    every route is Backoffice-only (route prefix `backoffice/gamification`,
    `@ApiTags('backoffice')`). `GamificationModule` already imports
    `BackOfficeModule`/`BackofficeRbacModule` one-way (for `AuditService`/
    RBAC guards); `BackOfficeModule` does not import `GamificationModule`
    back. Placing the new controller/service under `backoffice/` would
    require exactly that reverse import, creating a circular module
    dependency this codebase's module graph doesn't have anywhere else. The
    route path and Swagger tag communicate the administrative boundary to
    API consumers; the file location keeps the module graph acyclic.
- **Revocable achievements**: `PersonAchievement` gains `revokedById`/
  `revokedAt`. The old plain `@@unique([personId, definitionId])` index is
  replaced by a **partial unique index** scoped `WHERE "revokedAt" IS
  NULL` — hand-written directly in the migration SQL (Prisma's schema DSL
  cannot express partial indexes; the `schema.prisma` model itself carries
  only a plain `@@index` for lookup performance) — the identical technique
  and reasoning `staff_roles_staffId_roleId_active_key`/
  `role_permissions_roleId_permissionId_active_key`
  (`20260730102614_add_rbac_foundation`) already established: "at most one
  ACTIVE row per key at a time," full history preserved via revocation, not
  deletion. `unlockAchievement`'s existing-check moved from `findUnique` on
  the old compound key (which no longer exists) to
  `findFirst({ where: { personId, definitionId, revokedAt: null } })` —
  this also gives a revoked-then-re-granted achievement its correct,
  intended behavior for free: a person whose grant was revoked no longer
  counts as "already has it," so a later gameplay trigger or another manual
  grant creates a fresh row, exactly like a first-time unlock. No existing
  `PersonAchievement` row has `revokedAt` set (the column is new), so every
  pre-existing row is still "active" under the new index and the invariant
  it enforces is byte-for-byte identical to the old plain unique index for
  all data that exists today.
- **RBAC**: `GAMIFICATION_CORRECTION_MANAGE` is a new `PermissionKey`
  enum value, the MANAGE counterpart to the pre-existing
  `GAMIFICATION_ANALYTICS_VIEW` — same domain, same VIEW/MANAGE pairing
  convention as `MAINTENANCE_MODE_VIEW`/`MANAGE` and
  `FEATURE_FLAGS_VIEW`/`MANAGE`. Seeded (`prisma/seed/rbac.seed.ts`) and
  granted to Technical Admin alongside its existing
  `GAMIFICATION_ANALYTICS_VIEW` grant — "never grant MANAGE without its
  own VIEW counterpart," this file's existing, followed convention.
- **Validation**: all four correction DTOs (`AdjustXpDto`,
  `AdjustBuildingScoreDto`, `GrantAchievementDto`, `RevokeAchievementDto`)
  use `class-validator`. Signed amounts (`amount`/`delta`) are
  `@IsInt() @NotEquals(0)` — the same precedent `CreateAdjustmentDto`
  already established for "a zero-value correction does nothing and would
  produce a misleading audit record and ledger row for no actual change."
  `reason` is `@IsString() @MinLength(3)` on every DTO — mandatory,
  matching `AdminReversePaymentDto`'s "a staff-direct Force Action always
  carries a justification," with a floor length so a one-character
  placeholder can't satisfy it (`ToggleProviderSettingDto.reason`'s own
  precedent). `code` on the achievement DTOs is `@IsEnum(AchievementCode)`
  against the real Prisma enum directly, rather than a separately
  maintained string-literal list.
- **Tests**: `gamification.repository.spec.ts` and
  `gamification.service.spec.ts` gained coverage for pagination/filter
  behavior, the revoke-then-re-grant path, `personExists`/`buildingExists`,
  and all four correction methods (transactional balance/audit behavior,
  the structurally-unreachable duplicate-suppression guard on
  `adjustXp`, `DuplicateError`/`NotFoundAppError` on grant/revoke). A new
  `gamification-administration.service.spec.ts` covers the thin
  existence-check wrapper. `test/gamification.e2e-spec.ts` gained real
  pagination e2e coverage (page 1/page 2/limit/reason filter for XP
  history; page 1/page 2/deterministic tie-breaker for the leaderboard,
  using two same-score fixture buildings, not a shape-only check). A new
  `test/gamification-administration.e2e-spec.ts` mirrors
  `finance-administration.e2e-spec.ts`'s own dual-guard permission-proof
  shape (401/403×2/403-no-grant/granted-live/revoked-live) plus functional
  coverage of every correction: XP balance+ledger consistency (including a
  second, negative correction proving no idempotency collision), Building
  Score correction with a real league-tier transition, achievement
  grant/duplicate-rejection/revoke/re-grant-after-revoke, and that every
  mutation leaves a real, reason-carrying `AuditLog` row.

## Consequences

One new migration
(`20260808070000_gamification_scale_and_operations`) makes three additive,
non-destructive schema changes: adds `ADMIN_CORRECTION` to `XpReason`, adds
`GAMIFICATION_CORRECTION_MANAGE` to `PermissionKey`, and replaces
`person_achievements`'s plain unique index with the partial-unique-index
pair described above (safe against all pre-existing data — see Decision).
No existing row is edited, merged, or deleted by this migration.

**API contract changes** (documented here for Mobile Phase 3, which this
phase does not touch — no Flutter code was modified): `GET
/gamification/me/xp-history` and `GET /gamification/leaderboard` both now
return a paginated envelope (`data`: the same item array as before, now
possibly a bounded slice; `metadata.pagination`: `{page, limit, total,
totalPages}`) instead of an unbounded plain array — existing consumers that
assumed "the array is everything" will only ever see the first 20 items
(the default page size) once Mobile eventually calls these endpoints. Both
endpoints also accept new optional query parameters (`page`, `limit`, plus
`reason`/`fromDate`/`toDate` on `xp-history`). No route was removed or
renamed, and no previously-required field changed shape or meaning — this
is an additive, non-breaking contract change, but the paginated response
shape means Mobile Phase 3 will need real pagination UI (or an explicit
decision to always request `limit=100`, the max, if it prefers scrolling
without a "load more" affordance) rather than assuming today's "just render
the array" behavior. The committed `docs/openapi/v1.0-api-contract.json`
needs a re-export (`npm run docs:export-openapi`) to reflect both the
changed response shapes and the four new Backoffice correction routes —
not yet run in this environment (see README's "Known risk areas").

Reputation, Daily Missions, Seasonal Events, Rewards, Streaks, person-level
progression, and any Mobile-side work remain explicitly out of scope for
this phase, as does reopening Phase 1's own already-closed integrity fix.
Phase 3 (Mobile alignment with the new paginated contracts) is not started.
