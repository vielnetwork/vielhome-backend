# ADR-111 — Backoffice User Administration

**Status:** Accepted — Closed (2026-08-01)
**Context area:** 21_ADRs (Backend / Backoffice), Operational Readiness — Stage 4 of the Backoffice completion roadmap
**Related:** ADR-098 (Backoffice RBAC Foundation — reserved the `USER_VIEW`/`USER_EDIT` keys this ADR is the first to actually wire to a route), ADR-102 (Operations Admin already holds both keys in the seed matrix), ADR-031/ADR-043 (Fraud & Abuse Center's `isSuspended` flag and its live enforcement at login/every-request — this ADR reuses both without changing either), ADR-110 (Operational Dashboard — Stage 3, `MonitoringService`-reuse-not-reimplementation discipline followed here too for the Audit Center)

## Context

This is Stage 4 of the 10-stage Backoffice completion roadmap (Stages 1–3: Monitoring, Maintenance Mode/Feature Flags, Operational Dashboard, all Closed). A real-repo-state check for this stage found that `USER_VIEW`/`USER_EDIT` — two `PermissionKey` enum values reserved since ADR-098 and already granted to `Operations Admin` in the seed matrix — have **never been wired to a single route**: no `UserAdministrationController` (or equivalent) exists anywhere in this codebase, and platform staff have no general-purpose way to list, search, or view a `Person`'s administrative state.

A second, more concrete gap: `Person.isSuspended` (ADR-031) and its live enforcement (`JwtStrategy.validate()`, `AuthService.verifyOtp`/`refresh` — ADR-043) already exist and work correctly, but `BackOfficeRepository.suspendPerson()` has exactly one caller in the entire codebase (`FraudCaseService`'s `ACCOUNT_SUSPENSION` enforcement effect), and `BackOfficeRepository.reinstatePerson()` has **zero** callers anywhere. A platform staff member cannot lift a suspension at all today outside of whatever the Fraud Case appeal flow does at the `EnforcementAction` level, and cannot suspend an account for a reason that didn't originate as a formal Fraud Case (e.g. a Support-initiated suspension). This stage closes both gaps: it gives `USER_VIEW`/`USER_EDIT` their first real endpoints, and gives `reinstatePerson` its first caller.

## Decision — Permission Keys: Reuse, Don't Reinvent

No new `PermissionKey` enum value, no migration, in this stage. `USER_VIEW` and `USER_EDIT` already exist, already have the correct VIEW/mutate shape this codebase's convention expects, and are already granted to `Operations Admin` (the role whose own seed comment already describes it as covering "the building/user administration-adjacent domains"). Unlike ADR-109's `FEATURE_FLAGS` (which needed a real VIEW/MANAGE split this stage's own mandate required, superseding the old bare key), `USER_EDIT` already reads correctly as "mutate a Person's administrative state" — suspending or reinstating an account is exactly that. Reusing these two reserved keys as-is, rather than superseding them with new ones, is the more precedented, lower-risk choice: it is the smallest possible footprint for closing this gap, and it finally gives two three-stage-old placeholder keys their first real meaning.

## Decision — Endpoints

Four routes, added to the existing `BackOfficeModule` (the same module `PersonAccessController`/`FraudCaseController`/`SupportCaseController` already live in — this is squarely a "manage a `Person`'s administrative state" concern, the same category those controllers already cover, not a candidate for a new top-level module the way Monitoring/Maintenance/Dashboard were):

- `GET /api/v1/backoffice/users` — paginated (`page`/`limit`, ADR-072 convention), with `search` (case-insensitive `contains` across phone/email/first/last/full name), `isSuspended`, and `isBackofficeApproved` filters. Gated `REVIEWER`+ (the lowest legacy rank) + `USER_VIEW`.
- `GET /api/v1/backoffice/users/:personId` — profile fields, `isSuspended`, `isBackofficeApproved`, current (`isCurrent: true`) building memberships, and the `PlatformStaff` record if this Person is also platform staff. Same gate as list. 404s on an unknown id.
- `POST /api/v1/backoffice/users/:personId/suspend` — mandatory `reason`. Gated `SENIOR_REVIEWER`+ + `USER_EDIT`, matching `PersonAccessController`'s own precedent for a consequential, account-affecting mutation on the same `Person` entity.
- `POST /api/v1/backoffice/users/:personId/reinstate` — mandatory `reason`. Same gate as suspend.

`reason` is **mandatory** on both mutations (`@IsNotEmpty()`, not `@IsOptional()`) — unlike the pre-existing, out-of-scope `SetBackofficeApprovalDto.reason` (optional) — per this engagement's own General Principles, which explicitly lists Suspend as one of the action types that must always carry a staff-supplied justification. This stage does not retroactively make `SetBackofficeApprovalDto`'s own reason mandatory; that file is untouched (out of this stage's scope).

Both mutations are idempotent in the same sense `PersonAccessService.setBackofficeApproval` already established: re-suspending an already-suspended Person is a safe no-op with respect to the underlying flag, but is still written and freshly audited — a staff member re-affirming "still suspended, still for this reason" is real operational history, not noise to suppress.

## Decision — Audit Trail, Distinct From the Fraud Case Path

Two new audit actions: `PersonSuspendedByAdmin`, `PersonReinstatedByAdmin` — deliberately distinct from `FraudCaseService`'s own `EnforcementActionIssued`/`EnforcementActionAppealDecided` trail, even though both paths ultimately call the same `BackOfficeRepository.suspendPerson`/`reinstatePerson` methods. This lets an Audit Center reader always tell which workflow actually caused a given suspension — a formal Fraud Case enforcement action, or a direct staff decision made through this new, simpler endpoint. Both new action names were added to `ADR-110`'s `CRITICAL_AUDIT_ACTIONS` allowlist (Privilege/access-gate category), so a suspension or reinstatement issued through this stage's own endpoints also surfaces on the Operational Dashboard's recent-critical-events widget, the same as the Fraud Case path's own `EnforcementActionIssued` already does.

## Decision — Detail View Does Not Duplicate the Audit Center

The detail endpoint deliberately does **not** include this Person's own audit history inline. The real Audit Center search (ADR-029/ADR-034) already exists and already does this correctly; duplicating it here would mean either a second, narrower implementation of the same query logic or an inconsistent subset of it. This follows the exact "reuse, don't reimplement another domain's job" discipline ADR-110 established for its own `systemHealth` section (`MonitoringService.getOverview()` reused directly, not recomputed).

## Implementation

- `src/modules/backoffice/controller/user-administration.controller.ts` — the four routes.
- `src/modules/backoffice/application/user-administration.service.ts` — `list`, `getDetail`, `suspend`, `reinstate`.
- `src/modules/backoffice/application/dto/suspend-person.dto.ts`, `reinstate-person.dto.ts` — both mandatory-`reason` DTOs.
- `src/modules/backoffice/infrastructure/repositories/backoffice.repository.ts` — four new methods: `findPersonForSuspensionState` (existence + previous-value lookup, same shape as the pre-existing `findPersonForBackofficeApproval`), `searchPersons` (list/search/filter, same `where`-with-`undefined`-keys convention `listSupportCases` already established), `getPersonAdminDetail` (the detail query). `suspendPerson`/`reinstatePerson` themselves are unchanged — reused as-is.
- `src/modules/backoffice/backoffice.module.ts` — the new controller/service added to the existing module's `controllers`/`providers` arrays. No new module, no new import — `BackOfficeRepository`, `AuditService` (global), and both guards were already available in this module.

No schema change, no migration, no seed change — `USER_VIEW`/`USER_EDIT` and their existing grant to `Operations Admin` are reused exactly as they already were.

## Testing

- `src/modules/backoffice/application/user-administration.service.spec.ts` — `BackOfficeRepository`/`AuditService` fully mocked. Covers: list/detail pass filters and pagination through unmodified and build pagination meta from the real total; `getDetail` 404s via `NotFoundAppError` on an unknown id; `suspend`/`reinstate` both 404 on an unknown target (never touching the repository mutation or audit in that case), write through to the repository, audit with the correct distinct action name and a `metadata.previousValue`/`newValue` pair, and remain idempotent (re-suspending an already-suspended target still writes a fresh audit entry).
- `test/user-administration.e2e-spec.ts` — the first e2e coverage either `USER_VIEW` or `USER_EDIT` has ever had. Two independent 401/403×2/403-no-grant/granted-live/revoked-live blocks (one per permission key, since they gate different routes at different legacy ranks), plus a functional block proving: `search`/`page`/`limit` actually filter and paginate; the detail response's shape (profile fields, both administrative flags, `memberships` array); a 404 on an unknown `personId`; a missing `reason` 400s (DTO validation); and — the strongest proof this stage's endpoint is wired to something real, not just flipping an inert flag — a suspended target's very next OTP login attempt gets a real `403` (ADR-043's live check), and a subsequent reinstate makes a fresh login succeed again.

## Build / Unit / E2E Verification

This stage introduces zero schema/migration changes, so no Prisma-client hand-patch of any kind was needed — the real, already-generated client already supports every field and permission key this stage's code references.

- `npx eslint` on every new/changed file — clean (one prettier-only formatting fix applied to `user-administration.service.ts`, three to `user-administration.e2e-spec.ts`, via `--fix`).
- `npx tsc --noEmit` — **zero errors**, first attempt.
- `npm test` (full suite) — **569/569 passed, 46/46 suites**, including all 8 new `user-administration.service.spec.ts` tests, on the first run, with no bug found this time.
- `npm run build` — succeeded (after moving aside a stale `dist/` directory the mounted filesystem could not overwrite in place, the same recurring device-bridge quirk noted in ADR-110).
- `npm run test:e2e` was **not** run in this sandbox — this sandbox's `device_bash` shell has no reachable Postgres/Redis (established during ADR-110's own closure triage), so a real e2e run could not be executed here regardless of whether this stage touched the schema.

**The operator ran the real verification stack** (`npm run build`, `npm test`, `npm run test:e2e`) on their own machine:

## Final Verification (Closure Gate)

- `npm run build` — succeeded.
- `npm test` (full suite) — **569/569 passed, 46/46 suites**.
- `npm run test:e2e` — **one real bug found and fixed, one unrelated transient triaged and recorded**:
  1. **`test/user-administration.e2e-spec.ts`** — the "suspends the target..." and "reinstates the target..." tests
     both expected `200`, got `201`. A real, deterministic bug in this stage's own e2e test, not a production
     defect: NestJS's `@Post()` defaults to `201 Created`, unchanged in `UserAdministrationController.suspend`/
     `reinstate` — the exact same convention every other POST-mutation-on-an-existing-resource route in this
     codebase already follows (e.g. `PersonAccessController.set()`, whose own e2e suite already asserts `201` for
     the identical shape). Fixed in commit `f190094` by correcting the test's expectation to `201`, with an inline
     comment pointing at the precedent. No production code changed.
  2. **`test/documents.e2e-spec.ts`** — "shows a MANAGEMENT_ONLY document to a privileged list caller" (`GET
     /buildings/:id/documents`) failed with `expected 200, got 404` during the same full run. Untouched by this
     stage's own change set (`7a46426`, `f190094`) — no shared module, route, or permission — so per the
     roadmap's own Verification Gate this was not attributed to ADR-111. Confirmed as a transient via a genuine
     single-file-isolated rerun on the operator's own machine: **27/27 passed**, including the exact failing test.
     Recorded as a new ADR-107 addendum entry (the same `documents`-domain 404 symptom category ADR-107 already
     catalogues twice among its original six unreproducible transients).
  3. A subsequent isolated rerun of `test/user-administration.e2e-spec.ts` alone confirmed the fix: **14/14
     passed**.

ADR-111 is CLOSED on this basis: its own code and both test suites (unit + e2e) are fully green; the one
unrelated failure observed during the full run has been triaged to a known, pre-existing category of e2e
fragility, not a regression this stage introduced.

## Non-Goals (Phase 1)

Explicitly out of scope for this ADR, listed exhaustively:

- Editing a Person's profile fields (name/email/locale) through this endpoint — `USER_EDIT` here covers only the suspend/reinstate administrative-state actions; general profile editing (if ever needed as a staff action) is a separate concern with its own validation rules and was not requested for this stage.
- A "Lock" action distinct from Suspend. The roadmap's own General Principles list "Lock" among several example action types needing a mandatory reason (alongside Suspend/Refund/Correction/Repair/Force Action) — it is not a requirement that every domain implement a literal, separate Lock action. `Person` has exactly one administrative on/off flag (`isSuspended`), already fully enforced end-to-end (ADR-031/ADR-043); inventing a second, undefined "locked" state with no distinct semantics or enforcement point of its own would be exactly the kind of incomplete, ungrounded endpoint this engagement's own principles warn against ("never build incomplete endpoints for high-risk operations").
- A session/token force-revocation action ("force logout"). Investigated and deliberately not built: `JwtStrategy.validate()` already checks `isSuspended` live on every single authenticated request (ADR-043), so a suspended Person is blocked on their very next request regardless of whether their current access token is still technically unexpired — revoking `RefreshToken` rows in addition would prevent only a future *refresh*, which the live check already blocks anyway. There is no gap this would close.
- Inline audit history on the detail view (see Decision above — the real Audit Center already exists and is not duplicated here).
- Bulk actions (suspend/reinstate more than one Person per request).
- A `sortBy`/`sortOrder` query parameter — no existing list endpoint in this codebase has one (`SupportCaseController.list` doesn't either); this stage follows that same established convention rather than introducing a new one unilaterally.

## Consequences

- Positive: `USER_VIEW`/`USER_EDIT` go from three-stage-old inert placeholders to real, tested, audited endpoints.
- Positive: `reinstatePerson` gets its first caller — a platform staff member can now actually lift a suspension without going through the Fraud Case appeal machinery, closing a genuine functional gap this stage's own repo-state check discovered.
- Positive: zero new npm dependencies, zero schema/migration changes — the smallest-footprint stage of the roadmap after ADR-110.
- Neutral: `FraudCaseService`'s own `ACCOUNT_SUSPENSION` enforcement path is completely unchanged — it still calls the same two repository methods it always did; this stage adds a second, independent caller, not a replacement.
- Residual, tracked for later (see Future Review): no bulk actions; no profile-field editing; list has no configurable sort order.

## Future Review

- **Profile-field editing.** If a future requirement needs staff to correct a Person's name/email/locale directly (as opposed to the Person self-editing their own profile), that would need its own DTO, validation rules, and likely its own distinct audit action (`PersonProfileEditedByAdmin` or similar) — not folded into this stage's `USER_EDIT` suspend/reinstate scope without a dedicated design pass.
- **Bulk suspend/reinstate.** Not requested for this stage; if ever needed (e.g. suspending every account tied to a confirmed fraud ring in one action), it deserves its own request/response shape and its own audit-batching decision, not a naive loop over the single-target endpoint.
- **List sort order.** If user volume grows to where the fixed `createdAt desc` default becomes limiting, a `sortBy`/`sortOrder` pair could be added — but only once a second list endpoint in this codebase actually needs it too, so the convention is designed once, consistently, rather than per-endpoint.
