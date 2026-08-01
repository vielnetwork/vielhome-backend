# ADR-110 — Backoffice Operational Dashboard

**Status:** Accepted — Pending Closure (2026-08-01) — one unrelated e2e item (see Final Verification below) needs an isolated rerun before this can be marked Closed
**Context area:** 21_ADRs (Backend / Backoffice), Operational Readiness — Stage 3 of the Backoffice completion roadmap
**Related:** ADR-108 (Monitoring & System Health — Stage 1, this stage directly reuses `MonitoringService.getOverview()` for its own `systemHealth` section), ADR-109 (Maintenance Mode & Feature Flags — Stage 2), ADR-099/ADR-102 (VIEW/MANAGE permission-pair convention), ADR-034 (Audit & Compliance Center — the full-detail audit search this dashboard's own "recent critical events" widget deliberately does not replace), ADR-107 (E2E cleanup discipline — this ADR's own e2e suite follows its shared-fixture, no-exact-count-assertion rules)

## Context

This is Stage 3 of the 10-stage Backoffice completion roadmap (Stage 1: ADR-108 Monitoring, Stage 2: ADR-109 Maintenance Mode & Feature Flags, both Closed). The roadmap's own mandate for this stage is explicit: an **operational**, not decorative-analytics, dashboard — a single at-a-glance summary of real platform state a staff member would otherwise have to gather by opening several separate Backoffice screens: user/building counts, active vs. pending-verification buildings, the building- and manager-verification queues, fraud/compliance/support triage summaries, a narrowly-scoped finance summary, system health, queue/worker status, and recent high-risk audit events. Full per-domain detail (case lists, ledgers, individual audit records) already exists elsewhere in this codebase — this stage does not duplicate any of that, it only aggregates counts and summaries that domain already computes correctly.

The roadmap explicitly flagged one nuance for this stage: a "revenue summary" section is only appropriate "if a real, precisely-defined data source exists" — this ADR's own Finance decision below addresses exactly that caveat, deliberately choosing not to invent a derived revenue metric this dashboard has no business computing independently of the Finance module's own logic.

## Decision — Permission Key

A single, read-only key: `DASHBOARD_VIEW`. No `DASHBOARD_MANAGE` — this is a pure-read aggregation endpoint with no mutating action of its own, matching the exact precedent `AUDIT_VIEW` and ADR-108's own `MONITORING_VIEW` already established for this codebase's other pure-read Backoffice domains (a VIEW/MANAGE split is reserved for domains that actually have something to manage).

Granted to `Operations Admin` and `Technical Admin` (plus `Super Admin`, which holds every permission automatically) — reasoned as the two existing roles whose own descriptions already center on broad, day-to-day/platform-wide operational visibility, the same category of access this dashboard exists to summarize. Deliberately not granted to any narrow, single-domain admin role (Finance Admin, Support Admin, Marketplace Admin, Subscription Admin, Fraud & Compliance Admin) — a cross-domain summary is not those roles' own concern, and granting it to them would not follow this seed file's own "grant what the role's description says it needs" discipline.

## Decision — Endpoint & Response Shape

A single route: `GET /api/v1/backoffice/dashboard/overview`, gated `PLATFORM_ADMIN` (legacy floor) + `DASHBOARD_VIEW` (new RBAC) — the same dual-guard Bridge Migration shape every ADR-102/ADR-108/ADR-109 controller already uses.

The response has ten independent sections, each backed by a real, directly-defined query — no invented metric anywhere:

- **`users`** — `Person.count()`. A single total; no attempt to break this down by role/status in Phase 1 (see Non-Goals).
- **`buildings`** — total count, `active` (`status: VERIFIED`), `pendingVerification` (`status` in `PENDING`/`UNDER_REVIEW`/`PENDING_INFORMATION`).
- **`buildingVerification`** — pending count + breakdown by `VerificationPriority`, using `BuildingVerificationCase.decision: null` as the "pending" predicate — deliberately **not** `status`, which also holds non-decision transitional values; `decision` exists on that model specifically so a reader never has to reverse-engineer "still pending" from a status enum that means more than one thing (see that model's own schema comment).
- **`managerVerification`** — pending count + priority breakdown, using `ManagerVerificationCase.status: PENDING` — unlike Building Verification, `status`'s only non-terminal value on this model actually is `PENDING` (`VERIFIED`/`REJECTED`/`SUSPENDED` are all terminal), so this one case correctly uses `status` directly.
- **`fraud`** / **`compliance`** — identical shape (`open`/`underInvestigation`/`confirmedTotal`/`dismissedTotal`), because `ComplianceCase.status` reuses the exact same `FraudCaseStatus` enum as `FraudCase` by explicit prior design (see that field's own schema comment) — the same four-state investigation lifecycle, so the same shaping logic legitimately applies to both without coincidence.
- **`support`** — `SupportCase.status` (the shared `CaseStatus` enum: `OPEN`/`IN_PROGRESS`/`WAITING_USER`/`RESOLVED`/`CLOSED`) grouped into counts.
- **`finance`** — see its own decision below.
- **`systemHealth`** — `MonitoringService.getOverview()`, reused directly (not recomputed) from ADR-108's own module, so this dashboard's system-health section can never silently drift from what the dedicated Monitoring screen itself reports.
- **`recentCriticalAuditEvents`** — see its own decision below.

Every field is a real, currently-true count derived straight from that domain's own status/decision model — nothing here is a client-side rollup of numbers this endpoint invents its own definition for.

## Decision — Finance Section (the roadmap's own explicit caveat)

Per the roadmap's own instruction that a revenue summary needs "a real data source and a precise definition," this section is deliberately limited to simple, directly-defined aggregates only:

- `pendingApprovalCount` / `pendingApprovalAmount` — `Payment` rows with `status: PENDING_APPROVAL`.
- `approvedTotalAmount` — sum of `Payment.amount` where `status: APPROVED`.
- `refundedTotalAmount` — sum of `Refund.amount` (all rows — refunds have no further status lifecycle of their own).
- `openChargeBatches` — count of `ChargeBatch` rows with `status: ISSUED`.

This section explicitly does **not** compute an "outstanding balance owed" or "net revenue after refunds" derived metric — either would require re-implementing domain rules (proration, allocation order, per-unit vs. per-building rounding) that belong to the Finance module's own logic, not to a summary dashboard reading raw aggregates. See Non-Goals.

## Decision — Recent Critical Audit Events

`AuditLog` has no severity column (see that model's own schema comment / the Audit Center's own prior design discussion for why one was never added), so "critical" here is a curated, hand-picked allowlist of real `action` string values — `CRITICAL_AUDIT_ACTIONS` in `dashboard.service.ts` — every single one grepped from an actual, already-existing `audit.record({ action: '...' })` call somewhere in this codebase, never invented. Grouped into five categories: Fraud investigations, Compliance investigations, enforcement consequences (`EnforcementActionIssued`/`EnforcementActionAppealDecided`) and Legal Hold, platform-wide impact (`MaintenanceModeEnabled`/`MaintenanceModeDisabled`), financial reversals (`PaymentReversed`/`PaymentRefunded` — money already moved, then undone or returned), privilege changes (role/staff-role grant/revoke), and account-level access-gate changes (`PersonBackofficeApprovalChanged`).

Deliberately **excludes** routine verification decisions (`BuildingVerificationDecided`, `ManagerVerificationDecided`) — those already have their own dedicated pending-queue counts elsewhere on this same dashboard; repeating every decision here would bury the genuinely rare, high-risk events this widget exists to surface. The query itself never selects `AuditLog.metadata` (a dashboard glance view has no business surfacing whatever free-form detail a specific domain chose to log) or `buildingId`/`requestId` (not useful at this summary level) — a staff member who needs the full record already has the real Audit Center search/timeline endpoints (ADR-029/ADR-034) for that. Capped at the 20 most recent matching rows.

## Decision — Partial-Failure Isolation

Every section is fetched independently via `Promise.allSettled` — the exact same defensive aggregation pattern ADR-108's `MonitoringService` already established — with a small `unwrap()` helper providing a documented, typed fallback per section (e.g. `{ total: 0 }` for `users`, `{ status: 'unavailable' }` for `systemHealth`, `[]` for `recentCriticalAuditEvents`). This endpoint always returns HTTP 200 with whatever sections succeeded; one section's query failing (a transient DB blip, a slow query) never takes down the whole response, and never produces a 500 for what is fundamentally a partial-read situation, not a hard failure. Every fallback is logged via `Logger.error` with the section name, so a partial failure is still observable in application logs even though the HTTP response itself stays green.

## Implementation

New module, following the exact wiring template `MonitoringModule`/`MaintenanceModule` already established: import `BackOfficeModule` (for `PlatformRolesGuard`'s own `BackOfficeRepository` dependency), import `BackofficeRbacModule` (for `PermissionsGuard`), declare `PlatformRolesGuard` as a local provider (`BackOfficeModule` does not export it).

- `src/modules/dashboard/dashboard.module.ts` — new module, registered in `AppModule` after `MaintenanceModule`. Additionally imports `MonitoringModule` directly, purely to inject its exported `MonitoringService` — the one new wiring fact this stage introduces beyond the established template.
- `src/modules/dashboard/controller/dashboard.controller.ts` — the single route.
- `src/modules/dashboard/application/dashboard.service.ts` — all aggregation logic: `getOverview()` plus one private method per section (`getUsersSection`, `getBuildingsSection`, `getBuildingVerificationSection`, `getManagerVerificationSection`, `getFraudSection`, `getComplianceSection`, `getSupportSection`, `getFinanceSection`, `getRecentCriticalAuditEvents`), and two small pure-shaping helpers (`countByPriority`, `toTriageStatusSection`) factoring out only the row-to-count-map logic shared between Building/Manager Verification and Fraud/Compliance respectively. Each section calls its own concrete Prisma model directly — an earlier draft explored a generic, dynamically-indexed `this.prisma[model]` helper to share logic across those pairs, but this was deliberately rejected as inconsistent with this codebase's established style (no precedent anywhere else in this codebase for dynamic Prisma delegate access) in favor of four separately-named, fully-typed methods.
- `src/modules/monitoring/monitoring.module.ts` — one new export (`MonitoringService`), purely additive, so `DashboardModule` can reuse ADR-108's own system-health aggregation instead of duplicating Postgres/Redis/BullMQ/Storage check logic.
- `src/app.module.ts` — one new module import/registration, after `MaintenanceModule`.

## Schema / Migration / Seed

- `prisma/schema.prisma` — one new additive `PermissionKey` enum value (`DASHBOARD_VIEW`). No new models, no new fields, no new relations — this stage introduces no new persisted state of its own; it only reads existing tables.
- `prisma/migrations/20260801150000_add_dashboard_view_permission/migration.sql` — a single `ALTER TYPE "PermissionKey" ADD VALUE 'DASHBOARD_VIEW';`, hand-written in this sandbox in the exact shape `prisma migrate dev` itself generates for a single-value enum addition (matching ADR-108's own `20260801031055_add_monitoring_view_permission`). **This sandbox cannot run `prisma migrate dev` directly against the operator's own database** — this file was written by hand and must be reviewed alongside the schema diff before the operator runs `prisma migrate dev` for real.
- `prisma/seed/rbac.seed.ts` — one new `PERMISSIONS` entry; `'DASHBOARD_VIEW'` added to both `Operations Admin`'s and `Technical Admin`'s `ROLE_PERMISSION_MATRIX` arrays; both roles' `ROLE_DESCRIPTIONS` entries updated to mention the operational dashboard.

## Testing

- `src/modules/dashboard/application/dashboard.service.spec.ts` — Prisma and `MonitoringService` both fully mocked. Covers: the full happy-path shape of every section from its own real query; that `buildingVerificationCase` is queried strictly by `decision: null` (never `status`); that `managerVerificationCase` is queried strictly by `status: PENDING`; that the critical-audit query is scoped to `CRITICAL_AUDIT_ACTIONS` and never selects `metadata`; that a null Prisma aggregate sum (no matching rows) coerces to `0`, not `null`; the `Promise.allSettled` partial-failure contract (one section's mock rejection falls back to its documented empty shape while every other section still returns real data, including a full-failure case where every section rejects and `getOverview()` still resolves).
- `test/dashboard.e2e-spec.ts` — the same 401/403×2/403-no-grant/granted-live/revoked-live shape ADR-108's own `monitoring.e2e-spec.ts` established, plus a full response-shape assertion (every section's field types, without asserting exact counts — this suite runs concurrently against a shared seeded database, see ADR-107) and a no-leakage check (no `AuditLog.metadata`, no connection-string-shaped strings, no stack-trace-shaped lines, no `failedReason`).

## Build / Unit / E2E Verification

Unlike ADR-109 (which added two entirely new Prisma models and judged the local Prisma-client hand-patch too risky), this stage adds exactly **one** new `PermissionKey` enum value — the same situation ADR-108 was in. The same hand-patch technique was reused: `node_modules/.prisma/client/index.d.ts`'s `PermissionKey` const object had `DASHBOARD_VIEW: 'DASHBOARD_VIEW'` added by hand (type-only; this file is regenerated by the operator's own real `npx prisma generate` and is gitignored — never committed). This enabled a genuine, real in-sandbox verification pass:

- `npx eslint` on every new/changed file — clean. `dashboard.service.ts`/`dashboard.service.spec.ts` needed `--fix` for prettier-only formatting (applied). `prisma/seed/rbac.seed.ts` retains the same pre-existing, out-of-scope prettier drift already documented in ADR-108/ADR-109 (long single-line `ROLE_DESCRIPTIONS` string entries) — this stage's own two edited entries (`Operations Admin`, `Technical Admin`) follow that file's own pre-existing single-line convention and were not force-reformatted, consistent with the prior stages' choice not to blanket-fix files outside this stage's actual scope.
- `npx tsc --noEmit` — one real error caught and fixed: `unwrap<T>`'s `T` was inferred as bare `MonitoringOverview` from the `systemHealth` `Promise.allSettled` slot, which rejected the `{ status: 'unavailable' }` fallback's assignability. Fixed by passing an explicit `unwrap<MonitoringOverview | { status: 'unavailable' }>(...)` type argument at that one call site. **Zero errors after the fix** — a fully real, not stale-client-attributed, clean `tsc` pass.
- `npm test` (full suite) — **one real bug found and fixed** in this stage's own new `dashboard.service.spec.ts`: the happy-path test mocked `prisma.payment.aggregate` with a single `mockResolvedValue(...)`, not realizing `getFinanceSection` calls `payment.aggregate` twice (once for `PENDING_APPROVAL`, once for `APPROVED`) against the *same* mock function — so both calls silently returned the same canned value, and the test asserted `approvedTotalAmount: 0` while the service (correctly) computed the pending-approval amount for that field too, by coincidence of the mock, not a service defect. Fixed by switching to `mockImplementation` keyed on `where.status`, matching the pattern already used for the `building.count` mock in the same test file. After the fix: **561/561 tests passed, 45/45 suites**, including all 10 new `dashboard.service.spec.ts` tests.
- `npm run build` — succeeded (after moving aside a stale `dist/` directory whose `tsconfig.build.tsbuildinfo` this sandbox's mounted filesystem could not overwrite in place — a device-bridge filesystem quirk, not a build defect; the old `dist/` was moved aside, not deleted, and a fresh `dist/` was produced containing the new `dashboard` module's compiled output).
- `npm run test:e2e` was **not** run in this sandbox — `DASHBOARD_VIEW` does not yet exist in the operator's real Postgres `PermissionKey` enum (only the local, type-only `.d.ts` hand-patch exists), so seeding a `Permission` row with that key would fail against the real database until the operator's own `npx prisma migrate dev` actually applies `20260801150000_add_dashboard_view_permission`. Running e2e before that migration is applied would not be a meaningful signal — it is expected to fail for a reason entirely unrelated to this stage's code.

**The operator must, in order, on their own machine:** `npx prisma migrate dev` (applies `20260801150000_add_dashboard_view_permission`), `npx prisma generate` (this overwrites the local hand-patch above with the real generated client — expected and fine), `npm run db:seed:rbac` (idempotent), then `npm run build`, `npm test`, `npm run test:e2e`. This ADR is not Closed until that full sequence is confirmed green (or any failure has been triaged per the roadmap's own Verification Gate — isolated rerun, root-cause, compare against ADR-107's known patterns, before attributing anything to this stage).

## Final Verification (Closure Gate) — Pending One Triage Item

The operator ran the real verification stack (their own Postgres/Redis) after applying this stage's changes:

- `npx prisma migrate dev` — applied `20260801150000_add_dashboard_view_permission` successfully.
- `npx prisma generate` — succeeded (overwrote this sandbox's local hand-patch, as expected).
- `npm run db:seed:rbac` — succeeded.
- `npm run build` — succeeded.
- `npm test` (full suite) — **561/561 passed, 45/45 suites**, including all 10 new `dashboard.service.spec.ts` tests.
- `npm run test:e2e` — **653/655 passed, 23/25 suites**, with exactly two failures:
  1. **`test/dashboard.e2e-spec.ts` — "never leaks AuditLog.metadata..."**: a real, deterministic bug in this
     stage's own e2e test, not a transient and not a security defect. The assertion serialized the *entire*
     `res.body` and checked it never contains the string `"metadata"` — but this codebase's standard
     `ResponseInterceptor` envelope always carries its own top-level `metadata` field (e.g. `null`), unrelated to
     `AuditLog.metadata`, on every single response regardless of endpoint. The test's own blanket regex matched
     that harmless envelope key. Fixed in commit `c665903` by scoping the check to `res.body.data` only, where
     the real assertion belongs — the actual "no `AuditLog.metadata` leak" guarantee remains independently
     verified per-event in the preceding "well-shaped overview" test (`expect(event).not.toHaveProperty('metadata')`).
     No production code changed.
  2. **`test/gamification.e2e-spec.ts` — "granting GAMIFICATION_ANALYTICS_VIEW takes effect immediately"**: failed
     with `expected 200, got 404` during this same full run. This file is **untouched by this stage** — no shared
     module, controller path, permission key, or seed entry overlaps between `dashboard`/`ADR-110` and
     `gamification`/`ADR-079`/`ADR-102`'s own Gamification Analytics migration. Per the roadmap's own Verification
     Gate ("do not immediately attribute a full-suite failure to the current stage — isolated rerun, root-cause,
     compare against ADR-107 first"), this was **not** attributed to ADR-110. An isolated rerun of this one file
     was attempted from this sandbox but could not be completed — this sandbox's `device_bash` shell has no
     reachable Postgres/Redis (`ECONNREFUSED 127.0.0.1:6379`) even against the operator's own machine, a tooling
     limitation discovered during this triage, distinct from anything ADR-107 catalogues. A 404 (route not found)
     rather than a 403 (permission denied) is an unusual shape for what this test otherwise expects to be a
     pure-RBAC assertion, which does not match any pattern ADR-107 has previously recorded (all of ADR-107's own
     entries are FK/cleanup-race `PrismaClientKnownRequestError`s during `afterAll`, not mid-test HTTP-status
     mismatches). **This item is not yet closed** — see the immediate follow-up requested below.

**Outstanding before this ADR is fully Closed:** the operator needs to run `npx jest --config
./test/jest-e2e.json test/gamification.e2e-spec.ts` in isolation (no concurrently-running suites) on their own
machine. If it passes cleanly in isolation, this confirms a shared-fixture/concurrency artifact of the kind
ADR-107 already documents as a systemic property of this test setup (many suites against one shared dev
database) — in which case it will be recorded as a new ADR-107 addendum entry (a previously-uncatalogued 404
symptom) and this ADR closes on that basis. If it reproduces in isolation, it is a real, independent bug
unrelated to this stage's own change set and will be investigated as its own item, not blocking ADR-110's
closure (since ADR-110's own code and tests are otherwise fully verified above), but tracked before the roadmap
proceeds to Stage 4.

## Non-Goals (Phase 1)



Explicitly out of scope for this ADR, listed exhaustively:

- Any derived "outstanding balance" / "net revenue after refunds" financial metric (see Decision — Finance Section above).
- Breaking the `users` total down by role, verification status, or growth-over-time.
- Any time-series/historical trend data (this is a live, current-state snapshot only — trend analysis belongs to a later Analytics stage, per the roadmap's own stage ordering).
- Queue/worker/scheduler *detail* beyond what `MonitoringService.getOverview()` already returns — this dashboard reuses that section as-is, it does not add a second, competing view of the same infrastructure state.
- A full audit search/filter UI — `recentCriticalAuditEvents` is a fixed-size, fixed-allowlist glance view only; the real Audit Center (ADR-029/ADR-034) is unchanged and remains the tool for actual investigation.
- Configurable/personalized dashboard widgets (per-role or per-user layout) — one fixed shape, for every caller who holds `DASHBOARD_VIEW`.
- Caching the dashboard response — every call recomputes live; no staleness window was requested and none was added.

## Consequences

- Positive: staff with `DASHBOARD_VIEW` gain a single at-a-glance operational summary that was previously only obtainable by manually opening every one of the seven-plus screens this endpoint aggregates.
- Positive: zero new npm dependencies, zero new persisted tables — the smallest-footprint stage of the roadmap so far.
- Positive: the `systemHealth` section can never drift from ADR-108's own Monitoring screen, since it is the literal same call, not a reimplementation.
- Neutral: every section query runs on every single call to this endpoint (no caching) — acceptable for a low-traffic, staff-only glance-view endpoint; would need revisiting if this endpoint were ever polled at high frequency (see Future Review).
- Residual, tracked for later (see Future Review): the `CRITICAL_AUDIT_ACTIONS` allowlist is a hand-maintained list, not a query against a real severity field, and will silently miss a genuinely critical event whose `action` string is never added to it.

## Future Review

- **`AuditLog.severity` column:** if `CRITICAL_AUDIT_ACTIONS` becomes hard to keep in sync by hand as new audited actions are added elsewhere in the codebase, a real severity column on `AuditLog` (set at the call site, alongside `action`) would be a more robust long-term design than a hand-maintained allowlist living in this dashboard's own service file.
- **Dashboard response caching:** if this endpoint is ever polled frequently (e.g. an auto-refreshing staff UI), a short TTL cache (in-memory or Redis) would reduce load on the underlying per-domain tables — not needed today at expected staff-only, on-demand call volumes.
- **Historical/trend view:** the roadmap's own Stage 10 (Analytics) is the natural home for anything beyond this stage's live-snapshot scope.
