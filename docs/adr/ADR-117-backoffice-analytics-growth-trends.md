# ADR-117 — Backoffice Analytics (Growth & Trend Reporting)

**Status:** Accepted — Closed (2026-08-01)
**Context area:** 21_ADRs (Backend / Backoffice), Analytics — Stage 10 (final stage) of the Backoffice completion roadmap
**Related:** ADR-110 (Operational Dashboard — this ADR's own Non-Goals explicitly deferred "growth-over-time" and "any time-series/historical trend data" to "a later Analytics stage, per the roadmap's own stage ordering," the exact gap this ADR closes), ADR-108 (Monitoring & System Health — its own Future Review deferred *health-snapshot* trend history to this same Stage 10, a gap this ADR explicitly does NOT close — see Non-Goals), ADR-047 (Gamification Analytics — `GamificationController.getAnalytics()`/`GamificationService.getAnalytics()`, reused unchanged here rather than duplicated), ADR-115 (Reports & Export — establishes the sibling boundary: row-level CSV dumps vs. this ADR's aggregate trend series)

## Context

This is Stage 10, the final stage of the 10-stage Backoffice completion roadmap (Stages 1-9, all Closed). Two independent, literal schema comments both name Analytics as the one remaining gap:

- `07_BackOffice_v2.0` names nine core Backoffice modules (schema.prisma, BackOffice section comment): "Dashboard, Building Verification, Manager Verification, Fraud & Abuse, Subscription Center, Support Center, Audit Center, Analytics, Feature Flags." Every one of the other eight is now built — Dashboard (ADR-110), Building/Manager Verification (ADR-029), Fraud & Abuse (ADR-102 and follow-on triage stages), Subscription Center (ADR-101), Support Center (ADR-102), Audit Center (ADR-022/034/099), Feature Flags (ADR-109). Analytics alone remains.
- The Gamification schema section comment separately names "Analytics dashboard (DAU, XP Distribution, Retention, etc.)" as a deferred pillar, noting "no reporting layer/dashboard exists yet in any domain."
- ADR-110's own Non-Goals are the most direct and specific: "Breaking the `users` total down by role, verification status, or growth-over-time" and "Any time-series/historical trend data (this is a live, current-state snapshot only — trend analysis belongs to a later Analytics stage, per the roadmap's own stage ordering)."

A real-repo-state check confirmed: `Person.createdAt`, `Building.createdAt`, `Payment.approvedAt`, and `XpTransaction.createdAt` are all real, already-populated timestamp columns with genuine history since each row's actual creation/approval — no new snapshot table or background job is needed to have real historical data to report on. This is the crucial distinction from ADR-108's own deferred gap (see Non-Goals below): Monitoring's health-check results are never persisted anywhere, so a health *trend* would require inventing new snapshot infrastructure and accumulating history from scratch — explicitly out of scope here. Growth trends over existing, already-timestamped business records have no such gap; the history already exists, this stage only needs to query and bucket it.

`GamificationController.getAnalytics()` (ADR-047) already computes XP-by-reason distribution, league-tier distribution, and weekly active participants — staff-only, gated `SENIOR_REVIEWER` + `GAMIFICATION_ANALYTICS_VIEW`. This is a real, narrower analytics capability that already exists; this stage does not duplicate it, but reuses it directly as one section of the new cross-domain endpoint (the same "import the module directly for its exported service" pattern `DashboardModule` established for `MonitoringModule`).

## Decision — One New Endpoint: `GET /api/v1/backoffice/analytics/growth`

A single new, read-only, cross-domain endpoint, following `DashboardController`'s own precedent shape (one controller, one route, `PLATFORM_ADMIN` + a single new VIEW key, no MANAGE). Response sections:

- `newUsers` — `Person` rows bucketed by day of `createdAt` (count only).
- `newBuildings` — `Building` rows bucketed by day of `createdAt` (count only).
- `paymentsApproved` — `Payment` rows where `status = 'APPROVED'`, bucketed by day of `approvedAt` (count + sum of `amount`).
- `xpAwarded` — `XpTransaction` rows bucketed by day of `createdAt` (count + sum of `amount`).
- `gamification` — the literal, unmodified return value of `GamificationService.getAnalytics(fromDate, toDate)` (xpByReason distribution, league-tier distribution, weekly active participants) — not reimplemented, not restructured.

Every day in the resolved `[fromDate, toDate]` range appears in each of the four bucketed series, zero-filled — a client charting this data never needs to backfill gaps itself, and a day with no `newUsers` rows is genuinely reported as `0`, not silently omitted.

## Decision — Date Range: Optional Query Params, Default 30 Days, Hard Cap 90 Days

`fromDate`/`toDate` are optional ISO-8601 date query params. If omitted, the range defaults to the trailing 30 days (`[today - 29 days, today]`, inclusive — 30 buckets). If provided: `fromDate` must be `<= toDate`, and the resolved range must not exceed 90 days — both violations throw `ValidationError` (400), never a silent clamp. This mirrors ADR-115's `DEFAULT_EXPORT_ROW_CAP`'s own "bound the query, but disclose the bound rather than silently truncating" discipline: a client that requests 400 days gets a clear 400 error naming the 90-day limit, never a response that looks complete but silently only covers the first (or last) 90 days of what was asked for.

90 days was chosen as the cap because it bounds the worst-case row count this endpoint's JS-side bucketing (see below) reads into memory in a single request to a few thousand rows at this platform's current data volumes — the same "cap the query, not the response shape" reasoning `DEFAULT_EXPORT_ROW_CAP` already established for CSV export.

## Decision — JS-Side Day-Bucketing, Not `$queryRaw`/`date_trunc`

This codebase has zero existing precedent for a `GROUP BY`/`date_trunc`-style raw aggregate query (`grep` for `$queryRaw`/`$executeRaw` only turns up simple `SELECT 1` health-check pings in `MonitoringService`). Rather than introduce this codebase's first-ever hand-written, Postgres-dialect-specific aggregate SQL — which cannot be exercised against a real Postgres instance in this stage's own development sandbox, and would be this codebase's least-tested class of query if it shipped with a mistake — each series queries its own table with a plain, capped `findMany` (bounded by the `[fromDate, toDate]` range, itself capped at 90 days) selecting only the one timestamp column (+ `amount` where a sum is needed), then buckets the rows into day-keyed groups in plain TypeScript. At a 90-day cap this is at most a few thousand rows per series in memory — negligible cost for a staff-only, on-demand endpoint, and every line of the bucketing logic is exercised by ordinary Jest unit tests with mocked Prisma results, no live database required to prove it correct. See Future Review for revisiting this if data volume ever makes the plain `findMany` approach the wrong trade-off.

## Decision — Permission Key: a Single New `ANALYTICS_VIEW`, No `MANAGE`

No dormant `PermissionKey` was available to reuse (confirmed via the same exhaustive `grep -rhoP "RequiresPermission\('\K[A-Z_]+" src/` check every prior stage has run — every existing key is already wired to a route). `ANALYTICS_VIEW` is new, matching the `AUDIT_VIEW`/`MONITORING_VIEW`/`DASHBOARD_VIEW`/`GAMIFICATION_ANALYTICS_VIEW` precedent for a small, uniform, pure-read domain with no mutating action of its own — this endpoint has no `PATCH`/`POST`/`DELETE` route, so there is nothing for a `MANAGE` key to gate.

Gated `PLATFORM_ADMIN` (legacy floor) + `ANALYTICS_VIEW` (new RBAC), matching `DashboardController`'s own dual-guard shape exactly — this is a cross-domain aggregation endpoint over the same class of platform-wide operational data Dashboard already aggregates, not a narrow domain-scoped read. Granted to `Operations Admin` and `Technical Admin` in the seed matrix — the same two roles `DASHBOARD_VIEW` is already granted to, for the same "day-to-day / platform-wide operational visibility" reasoning both roles' existing grants already document.

## Decision — Not Audited (Unlike ADR-115's Export Routes)

This endpoint is deliberately **not** wrapped in an `audit.record(...)` call, unlike ADR-115's four CSV-export routes. The distinction: ADR-115's exports are raw, row-level dumps of PII-bearing records (phone, email, full name) — a bulk data-export action this codebase's own precedent (`AuditController.export`) already treats as sensitive enough to log. This endpoint returns only day-bucketed counts and sums — aggregate, statistical figures with no per-record PII, the same shape of response `DashboardController.overview()` and `GamificationController.getAnalytics()` already return today with no audit call of their own. Auditing a read that returns no identifiable individual's data would not match any existing precedent in this codebase and was deliberately not introduced here.

## Non-Goals

- **Health-snapshot trend history** (ADR-108's own deferred gap): monitoring's health-check results are never persisted, so a "was the queue backed up an hour ago" trend would require new snapshot infrastructure and accumulating history from scratch — a materially different, larger stage than this one. Not addressed here.
- **Row-level CSV export of this endpoint's data**: ADR-115 (Reports & Export) already covers raw row-level dumps per domain; this endpoint is aggregate trend data, a distinct concern with its own distinct boundary — no CSV/PDF/XLSX export of the growth series is added.
- **Per-building or per-user breakdown**: every series is platform-wide only, matching `DashboardOverview`'s own "one fixed shape, no per-entity breakdown" precedent.
- **Finer-than-daily buckets** (hourly/real-time): daily is the coarsest granularity that still answers "is this metric trending up or down," and the finest this stage needs — no live/streaming view was requested.
- **Date ranges beyond 90 days, or a "since inception" all-time view**: bounded by the query-cost reasoning above; a longer-range or pre-aggregated (e.g. weekly/monthly rollup) view is a Future Review candidate, not built here.
- **Forecasting or prediction of any kind**: every figure returned is a real, already-recorded historical fact — no extrapolation, no projected/estimated value of any kind.
- **Response caching**: matching `DashboardService`'s own "no staleness window requested, recomputes live every call" precedent — acceptable at this endpoint's expected staff-only, on-demand call volume.
- **Any additional domain's own series** (e.g. Notification delivery volume, Support case volume, Fraud/Compliance case volume over time): scoped exactly to the two literal gaps this ADR's Context section cites — Future Review candidates, not built here.

## Implementation

- `prisma/schema.prisma` — one new `PermissionKey` enum value, `ANALYTICS_VIEW`, appended after `PROVIDER_SETTINGS_MANAGE`. No new model, no new table, no new relation.
- `prisma/migrations/20260801170000_add_analytics_view_permission/migration.sql` — hand-authored, single `ALTER TYPE "PermissionKey" ADD VALUE 'ANALYTICS_VIEW';`, matching the `20260801150000_add_dashboard_view_permission` migration's own single-enum-value precedent exactly.
- `src/modules/analytics/analytics.module.ts` — new module. Imports `BackOfficeModule` + `BackofficeRbacModule` (same `PlatformRolesGuard`/`PermissionsGuard` wiring template every Bridge Migration module uses) and `GamificationModule` directly, purely to inject its exported `GamificationService` — the same no-cycle-risk "import the module directly for its exported service" pattern `DashboardModule` established for `MonitoringModule`. `GamificationModule` does not import `AnalyticsModule` (or anything that transitively does) — no cycle.
- `src/modules/analytics/controller/analytics.controller.ts` — `@Get('growth')`, gated `PLATFORM_ADMIN` + `ANALYTICS_VIEW`, accepts optional `fromDate`/`toDate` query params (plain strings, parsed by the service — same lightweight shape `GamificationController.getAnalytics()` already uses, no DTO class needed for two optional read-only query params).
- `src/modules/analytics/application/analytics.service.ts` — `AnalyticsService.getGrowth(fromDate?: string, toDate?: string)`: resolves/validates the range (defaults, `ValidationError` on `from > to` or `> 90` days), runs the four `findMany` queries + `GamificationService.getAnalytics()` via `Promise.all`, buckets each series by day (zero-filled), returns the combined shape.
- `src/app.module.ts` — registers `AnalyticsModule`, placed after `ProviderSettingsModule`/before `SchedulerModule` (matching every other Bridge-Migration-style module's own "no startup-order dependency, purely on-demand per-request reads" placement reasoning).
- `prisma/seed/rbac.seed.ts` — new `ANALYTICS_VIEW` entry in `PERMISSIONS`; added to `Operations Admin` and `Technical Admin` in `ROLE_PERMISSION_MATRIX`, matching both roles' existing `DASHBOARD_VIEW` grant reasoning verbatim.
- `test/helpers/e2e-identity.ts` — new `ANALYTICS: 30` entry in `E2E_SUITE_ID`.

## Testing

- `analytics.service.spec.ts` — unit tests: default 30-day range when no params given; explicit range accepted; `from > to` throws `ValidationError`; range `> 90` days throws `ValidationError`; day-bucketing zero-fills every day with no matching rows; count/sum bucketing is correct against a small fixed fixture; `gamification` section is the literal, unmodified return value of the (mocked) `GamificationService.getAnalytics()` call, called with the same resolved `fromDate`/`toDate`.
- `test/analytics.e2e-spec.ts` — following `dashboard.e2e-spec.ts`'s own single-VIEW-key template exactly: 401 unauthenticated; 403 plain non-staff; 403 `REVIEWER` (below `PLATFORM_ADMIN`); 403 `PLATFORM_ADMIN`-ranked staff with no `ANALYTICS_VIEW` grant (proves `PermissionsGuard` enforces independently of the legacy rank check); granting `ANALYTICS_VIEW` opens the route and returns a well-shaped response (every series is an array of `{ date, ... }` objects, one entry per day in the resolved range, `gamification` present and shaped); a `400` for `fromDate > toDate`; a `400` for a range `> 90` days; a leakage check (no `AuditLog.metadata`, no raw stack traces, no `postgres(ql)?://`); revoking `ANALYTICS_VIEW` closes the route again, live and uncached — matching `dashboard.e2e-spec.ts`'s own "deliberately does NOT assert on exact counts, only shape/types/non-negativity" discipline, since this suite runs concurrently with every other e2e file against the same shared, seeded database (ADR-107).

## Build / Unit / E2E Verification

`ANALYTICS_VIEW` is a genuinely new `PermissionKey` enum value — not yet present in the generated Prisma Client until `npx prisma generate` runs against the new migration. Per the ADR-109/ADR-116 precedent for this exact class of stage, `npx tsc --noEmit` was run across the whole project in-sandbox and every resulting error was manually confirmed to be attributable **only** to the stale, not-yet-regenerated client (the literal `'ANALYTICS_VIEW'` string argument to `@RequiresPermission(...)` and the `PERMISSIONS`/`ROLE_PERMISSION_MATRIX` seed entries, each rejected because the stale `PermissionKey` union doesn't yet include the new value) — no other, unrelated error. `npm run build`/`npm test`/`npm run test:e2e` were deliberately not run in-sandbox for this same reason (they would hit the identical stale-client errors and be meaningless); the operator is asked to run `npx prisma migrate dev`, `npx prisma generate`, `npx prisma db seed`, then the full build/unit/e2e sequence directly.

## Consequences

- Positive: closes the final named gap in `07_BackOffice_v2.0`'s own nine-module Backoffice scope — this is the roadmap's last stage.
- Positive: zero new tables, zero new relations — the second-smallest schema footprint of the roadmap after ADR-115 (which needed none at all).
- Positive: the `gamification` section can never drift from ADR-047's own Gamification Analytics screen, since it is the literal same call, not a reimplementation.
- Neutral: every series query runs on every single call to this endpoint (no caching), same trade-off `DashboardService` already accepted for a low-traffic, staff-only glance-view endpoint.
- Residual, tracked for later (see Future Review): a 90-day cap means no built-in "since inception" or year-over-year view; a longer-range caller has to make multiple capped calls and stitch them client-side if they need more history than one call provides.

## Future Review

- **Longer-range / pre-aggregated rollups:** if staff need more than 90 days in one call, a weekly/monthly rollup table (populated by a scheduled job, reusing `SchedulerModule`) would avoid raising the per-request row cap indefinitely.
- **Health-snapshot trend history:** ADR-108's own deferred gap remains open — would need a new persisted snapshot table and a scheduled job to populate it over time, a materially larger stage than this one.
- **Additional domain series** (Notification delivery volume, Support/Fraud/Compliance case volume over time): natural extensions of this same endpoint's shape, not built in this stage since neither of the two schema comments motivating this ADR named them.
- **`$queryRaw`/`date_trunc`-based aggregation:** if data volume ever grows past what a 90-day-capped `findMany` can comfortably bucket in application memory, a real Postgres-side aggregate query (with real integration-test coverage against a live database, not this stage's in-sandbox-only tsc check) would be the natural next step — deliberately not introduced pre-emptively in this stage, per the Decision above.

## Final Verification (Closure Gate)

Real, operator-run verification (not in-sandbox) confirmed green:

- `npx prisma migrate dev`, `npx prisma generate`, `npm run db:seed:rbac` all completed without error — the new `ANALYTICS_VIEW` `PermissionKey` enum value is live in the real dev database and the generated Prisma Client, and the new permission + its `Operations Admin`/`Technical Admin` grants are seeded.
- `npm run build` succeeded.
- `npm test`: **629/629 passed, 53 suites** (up from 621/621, 52 suites at ADR-116's own closure) — the +8 delta is exactly the 8 new tests in `analytics.service.spec.ts` (6 date-range-resolution tests + 1 bucketing test + 1 gamification-reuse test), confirming the new suite is genuinely exercising the new code path, not a coincidental pass.
- `npm run test:e2e`: **744/744 passed, 31 suites** (up from 734/734, 30 suites at ADR-116's own closure) — the +10 delta is exactly the 10 new test cases in `test/analytics.e2e-spec.ts` (401/403×3/granting+shape/explicit-range/400×2/leakage/revoking).
- No transient failures, no triage needed, no comparison against ADR-107 required — every suite passed cleanly on the operator's first real run.

This closes Stage 10, the final stage of the 10-stage Backoffice completion roadmap.
