# ADR-107 — E2E Cleanup Must Never Use Broad Predicates Against Shared Seeded Fixtures

**Status:** Accepted — Closed (2026-07-31)
**Context area:** 21_ADRs (Testing / Backend e2e suite), Technical Debt
**Related:** ADR-098/ADR-099/ADR-101/ADR-102 (Backoffice RBAC Foundation), `prisma/seed.ts` (`PLATFORM_ADMIN_PHONE`, `PLATFORM_REVIEWER_PHONE`)

## Context

`npm run test:e2e` runs every `*.e2e-spec.ts` file as a **separate, concurrent Jest worker process**, with no coordination between them, all pointed at the same shared dev Postgres database. Several long-lived, hardcoded fixtures are intentionally shared across nearly every e2e file rather than created per-suite:

- The two seeded `PlatformStaff` phones (`PLATFORM_ADMIN_PHONE = '+989120000000'`, `PLATFORM_REVIEWER_PHONE = '+989120000001'`) — the only way to reach `PlatformRolesGuard`-gated routes without a self-service admin-bootstrap flow.
- That same seeded admin's `PlatformStaff.id` (`staffId`), used by any suite exercising RBAC (`StaffRole`/`RolePermission`) grants against it.

A per-file cleanup helper (`cleanupStaffLoginArtifacts`, `cleanupRbacFixtures`, etc., each duplicated locally per this codebase's own "no shared test helper module" convention) runs in every suite's `afterAll` to keep `RefreshToken`/`Device`/`OtpRequest`/`StaffRole`/`RolePermission` rows from unboundedly accumulating across repeated runs.

Two independent instances of the same defect shape were found and fixed in this cycle:

1. **`backoffice-rbac.e2e-spec.ts`** — `cleanupRbacFixtures` ran `staffRole.deleteMany({ where: { staffId: { in: staffIds } } })`, with no `roleId` filter. Because `staffIds` was the *shared* seeded admin's `staffId`, this deleted **every** active `StaffRole` row for that staff member — including another concurrently-running suite's own, unrelated grant (e.g. `manager-verification.e2e-spec.ts`'s own ADR-102 fixture role).
2. **`notifications.e2e-spec.ts`** — `cleanupStaffLoginArtifacts` ran `otpRequest.deleteMany({ where: { phone: { in: phones } } })`, with no filter on whether a row was still active. Because the phones are shared, this could delete another suite's freshly-created, not-yet-consumed `OtpRequest` row mid-`requestOtp`→`verifyOtp`.

## Symptom pattern (how this actually presented)

Both defects produced the same *shape* of confusing, misleading failure, and both were initially indistinguishable from a real production bug:

- **Case 1 (RBAC):** a permission grant made by one suite (`RolePermission`/`StaffRole` created, confirmed present) appeared to have no effect — the guarded route still returned 403 immediately after granting. Root cause: the `StaffRole` row itself had already been deleted by a *different* suite's overly broad teardown, running concurrently. This looked exactly like a `PermissionsGuard`/`PermissionResolverService` defect and cost significant investigation time before the cross-suite angle was considered.
- **Case 2 (Auth/OTP):** `verifyOtp(...).expect(200)` returned 422 ("No active code found"), and separately, `AuthRepository.consumeOtp`'s `update()` threw Prisma P2025 ("Record to update not found"). Both are the application behaving *correctly* against a row that had already been deleted out from under it. The cascading secondary symptom — `staffRole.update({ where: { id: undefined } })` — was not an independent bug either: it was the direct consequence of `loginAsSeededStaff` throwing inside a `beforeAll` (uncaught, because its own retry logic only handles the 500 variant of this race, not the 422 variant), leaving downstream fixture-id variables (`adminGrantId`, etc.) unassigned by the time `afterAll` ran.

In both cases, the fix was **not** in the shared production authorization/authentication code (`PermissionsGuard`, `PermissionResolverService`, `AuthService`, `AuthRepository`) — that code was independently re-verified correct in both investigations. The defect was entirely in test-only cleanup predicates.

## Root Cause

Cleanup code in multiple e2e files deleted rows using predicates scoped **only to a shared seeded identifier** (a shared phone number, or a shared staff member's id) rather than to the specific rows that suite itself created or is otherwise certain are safe to remove. Under parallel Jest workers sharing one database, "shared identifier" is not a safe deletion boundary — any suite touching the same identifier can be an unwitting victim of another suite's teardown, and vice versa.

## Resolution

Narrow each offending predicate to something that can only ever match rows the current suite owns, or rows that are unconditionally safe regardless of owner:

- **`backoffice-rbac.e2e-spec.ts`:** `staffRole.deleteMany` now filters on **both** `staffId: { in: staffIds }` **and** `roleId: { in: roleIds }` — since each suite's fixture `Role` is uniquely named/created per run, this can only ever match `StaffRole` rows this suite itself created, never another suite's grant against the same shared staff member.
- **`notifications.e2e-spec.ts`:** `otpRequest.deleteMany` now additionally requires `OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }]` — i.e. only rows that are already consumed or already expired. Every row a suite's own successful login flow creates is guaranteed to already be consumed by the time its `afterAll` runs (a successful `verifyOtp` always calls `consumeOtp`), so this loses no real cleanup coverage for the suite's own rows, while making it structurally impossible to delete another suite's still-active, in-flight row.

Both fixes were applied to **test code only** — no production guard, resolver, service, or repository logic was changed, and no test expectations were weakened to paper over the symptom.

## Initial Verification

The cleanup predicate changes were validated by a full parallel e2e run.

Results:

- Test Suites: 22/22 passed
- Tests: 617/617 passed
- Snapshots: 0

The previously failing ADR-102 Manager Verification permission migration tests
and Notification Template permission migration tests both passed without any
production authorization or authentication changes.

This confirms the failures originated from cross-suite cleanup interference,
not from `PermissionsGuard`, `PermissionResolverService`, `AuthService`, or
`AuthRepository`.

## Final Verification (Closure Gate)

This ADR's scope grew over the closure cycle beyond the two fixes above.
The following shared-fixture/cleanup races were investigated and confirmed
fixed, all in test code only — no production guard, resolver, service, or
repository logic was changed for any of them:

- **A.1 — `deviceToken`-scoped `RefreshToken`/`Device` cleanup.** Every
  e2e file's `cleanupStaffLoginArtifacts`/`deleteStaffLoginArtifactsOnceBatch`
  pair was narrowed from a broad `person: { phone: { in: phones } } }`
  predicate (which could delete another concurrently-running suite's
  `RefreshToken`/`Device` rows for the same shared seeded phone) to a
  `deviceToken: { in: deviceTokens } }` predicate scoped to the exact
  device tokens this suite's own `loginAsSeededStaff` calls minted.
- **A.2 — suite-owned reviewer/admin isolation.** Suites that need an
  elevated permission during a run now grant it via their own disposable,
  suite-owned `Role`/`RolePermission`/`StaffRole` fixture (e.g.
  `grantFraudAdminToStaff`, `grantSupportAdminToStaff`,
  `grantComplianceAdminToStaff`) rather than mutating the shared seeded
  `PlatformStaff` row's permissions directly, so one suite's elevation and
  teardown can never race another suite's use of the same shared identity.
- **`backoffice-rbac.e2e-spec.ts` roleId-scoped cleanup** — `cleanupRbacFixtures`'s
  `staffRole.deleteMany` narrowed to filter on both `staffId` and `roleId`
  (see Resolution above).
- **Consumed/expired-only OTP cleanup** — `otpRequest.deleteMany` narrowed
  to `OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }]`
  across every e2e file using the shared seeded phones (see Resolution
  above), not just `notifications.e2e-spec.ts`.
- **Building Verification test synchronization** — `test/building-verification.e2e-spec.ts`
  added a bounded-polling helper, `waitForInitialCaseAtBuildingStatus`,
  that waits for both the `BuildingVerificationCase` row to exist and the
  `Building.status` to reach the expected value before asserting, closing
  a test-side race between building creation and the async auto-evaluation
  side effect. Test-only; no production code changed.
- **Fraud teardown hardening** — `test/fraud-case.e2e-spec.ts`'s
  "Enforcement Against a Person" describe's `afterAll` now wraps its
  `revokeStaffRoleGrant`/`staffRole.delete` calls in `try/finally` with
  `if (id)` guards, so `app.close()` always runs even if an earlier
  teardown step throws on an id left unassigned by a failed `beforeAll`.
- **E2E connection-budget fix** — `test/jest-e2e.json` sets
  `"maxWorkers": 4`, and a new `test/jest-global-setup.ts` injects
  `connection_limit=5` into `DATABASE_URL` at Jest's parent-process
  `globalSetup` phase (inherited by forked worker processes) — capping
  worst-case demand at 4 workers × 5 connections = 20, well under
  Postgres's `max_connections`, and eliminating the
  `PrismaClientInitializationError: Too many database connections opened`
  failure mode. This only affects `npm run test:e2e`; the on-disk `.env`
  and every other npm script are untouched.

**Final closure gate result:**

- Official closure Runs 1–4: 22/22 suites, 617/617 tests, each run.
- Run 5 surfaced one isolated Finance 404 with no demonstrated
  ADR-107 shared-infrastructure cause; the exact Finance test passed
  repeatedly in isolation afterward.
- Replacement Run 5: 22/22 suites, 617/617 tests.
- Before the official gate, an additional 5 consecutive full-parallel
  diagnostic runs also passed 22/22, 617/617.

ADR-107 is CLOSED on this basis.

## Non-Blocking / Follow-Up Technical Debt

The following items were identified during closure verification but are
explicitly **out of scope for this ADR** and are not fixed here. None of
them were demonstrated to share this ADR's root cause (a cleanup
predicate scoped only to a shared identifier); they are recorded so a
future ADR/task can pick them up deliberately rather than being
rediscovered from scratch:

- **Weak `RUN_ID` uniqueness.** `RUN_ID = Date.now().toString().slice(-3) + process.pid.toString().slice(-2)`
  is duplicated identically across roughly 21 e2e files. It is a coarse,
  non-cryptographic discriminator (5 characters derived from a timestamp
  tail and a PID tail) that could theoretically collide across suites.
  No specific observed failure in this closure cycle was traced to a
  `RUN_ID` collision — it is recorded as latent risk, not a confirmed bug.
- **Fire-and-forget `BuildingCreatedEvent` listener vs. `SubscriptionChangeLog`
  teardown race.** An occasional `subscription_change_logs_subscriptionId_fkey`
  violation was observed, consistent with the listener's async work
  landing after some suite's own relatively-fast teardown had already run.
  Investigation confirmed this is not Building-cascade-related and not
  reachable via cross-suite cleanup (every `cleanupBuildings()` helper is
  scoped to its own suite's `buildingId` array), so it sits entirely
  outside this ADR's shared-predicate root cause. Left as follow-up.
- **Isolated, unreproducible HTTP-status transients.** Across separate
  gate runs, six different routes each produced one unexplained
  HTTP-status mismatch in isolation (support-case metrics 404-vs-403,
  marketplace does-not-exist 400-vs-404, fraud-case otp/request
  404-vs-200, finance charge-creation 404-vs-201, documents-storage 25MB
  ceiling 404-vs-400, documents re-upload (Rule 021) 404-vs-201). Each was
  traced exhaustively with no demonstrable code-level cause found, and
  each reproduced cleanly when run in isolation afterward. They are
  flagged as a possible shared systemic issue (e.g.
  HTTP-adapter/connection-handling behavior under load) worth its own
  dedicated investigation, but none had a demonstrated ADR-107
  shared-state cause, so none are fixed here.

## Lesson Learned / Testing Guideline (proposed, for this codebase's e2e conventions going forward)

> **Parallel e2e suites must never perform cleanup using a predicate scoped only to a shared identifier** — a shared seeded phone number, a shared seeded `PlatformStaff`/staff id, a shared role name, or any other identifier more than one concurrently-running suite can legitimately touch.
>
> Every cleanup `deleteMany`/`updateMany` must instead be scoped by at least one of:
> - an exact row id (or list of ids) the suite itself created and tracked (the existing, already-dominant convention — most suites already do this for `StaffRole`/`Role` via `staffRoleGrantId`/`testRoleId`), **and/or**
> - a suite-exclusive discriminator (e.g. `RUN_ID`-suffixed fixture names, phones minted via `nextPhone()` which are inherently process-exclusive), **and/or**
> - a state predicate that is unconditionally safe regardless of which suite owns the row (e.g. `consumedAt: { not: null }`, `expiresAt: { lt: now }`, `revokedAt: { not: null }`).
>
> A predicate scoped only to "the shared identifier this suite happens to also use" is not sufficient, even if it looks narrow at a glance (e.g. `staffId: { in: [oneKnownId] }` looks precise, but is not, when that one known id is itself shared across suites).
>
> When a permission/auth-adjacent e2e assertion fails in a way that looks like the authorization/auth layer itself is wrong (a grant "has no effect," a "record not found" on a row that should exist), and the same production code path is independently proven correct elsewhere (e.g. an identical pattern passes in a sibling suite), **investigate cross-suite cleanup interference before suspecting the production code** — both incidents this cycle cost real investigation time chasing a nonexistent production defect before the shared-fixture-cleanup angle was considered.

## Consequences

- Positive: closes the cross-suite cleanup races identified during this cycle (backoffice-rbac roleId scoping, notifications/OTP consumed-or-expired scoping, A.1 deviceToken-scoped RefreshToken/Device cleanup, A.2 suite-owned reviewer/admin isolation) without touching any production authorization/authentication code; all are now structurally impossible to reintroduce via the same mechanism in the files touched this cycle.
- Positive: the underlying e2e connection-budget failure mode (`maxWorkers`/`connection_limit` unbounded) is fixed at the Jest/Prisma configuration layer, independent of any single suite's cleanup logic.
- Residual risk (follow-up Technical Debt, not closed by this ADR): each suite still keeps its own local copy of the cleanup helper functions rather than sharing a common test utility, so the same broad-predicate mistake remains possible in any *new* e2e file written after this closure. A dedicated follow-up ADR/task should extract a single shared, correctly-scoped helper module so this becomes a structural guarantee rather than a per-file discipline problem. See "Non-Blocking / Follow-Up Technical Debt" above for the additional specific items (RUN_ID uniqueness, BuildingCreated/SubscriptionChangeLog teardown race, unreproducible HTTP-status transients) carried forward from this closure.
