# ADR-107 — E2E Cleanup Must Never Use Broad Predicates Against Shared Seeded Fixtures

**Status:** Accepted
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

## Verification

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

- Positive: closes two concrete, reproducible cross-suite races without touching any production code; both are now structurally impossible to reintroduce via the same mechanism in these two files.
- Residual risk (follow-up Technical Debt): similar cleanup patterns still exist in multiple e2e files because each suite keeps its own local copy of helper functions rather than sharing a common test utility. Those cleanup helpers should be audited individually to ensure they never use broad predicates against shared seeded fixtures. A dedicated follow-up ADR/task should either (a) audit and narrow every remaining instance the same way, or (b) extract a single shared, correctly-scoped helper so this isn't a per-file discipline problem going forward.
