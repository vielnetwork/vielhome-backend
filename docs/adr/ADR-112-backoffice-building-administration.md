# ADR-112 — Backoffice Building Administration

**Status:** Proposed — pending the operator's real build/unit/e2e verification run
**Context area:** 21_ADRs (Backend / Backoffice), Operational Readiness — Stage 5 of the Backoffice completion roadmap
**Related:** ADR-098 (Backoffice RBAC Foundation — reserved the `BUILDING_VIEW`/`BUILDING_EDIT` keys this ADR is the first to actually wire to a route), ADR-102 (Operations Admin already holds both keys, Finance Admin/Support Admin hold `BUILDING_VIEW` alone, in the seed matrix), ADR-029 (Building Verification Queue — `updateBuildingStatus`/Recovery Mode's original owner), ADR-031 (Fraud & Abuse Center's `VERIFICATION_REVOCATION` enforcement effect — the other existing caller of `updateBuildingStatus`), ADR-111 (User Administration — Stage 4, the direct structural precedent this stage mirrors for `Person` → `Building`)

## Context

This is Stage 5 of the 10-stage Backoffice completion roadmap (Stages 1–4: Monitoring, Maintenance Mode/Feature Flags, Operational Dashboard, User Administration, all Closed). A real-repo-state check for this stage found the exact same shape of gap ADR-111 found for `USER_VIEW`/`USER_EDIT`: `BUILDING_VIEW`/`BUILDING_EDIT` — two `PermissionKey` enum values reserved since ADR-098 and already granted to `Operations Admin` (both) and `Finance Admin`/`Support Admin` (`BUILDING_VIEW` alone) in the seed matrix — have **never been wired to a single route**. The only building-facing Backoffice controllers that exist are `BuildingVerificationController`/`BuildingVerificationAppealController`, both gated by the separate `BUILDING_VERIFICATION_VIEW`/`BUILDING_VERIFICATION_MANAGE` keys and scoped specifically to the verification-queue workflow (a `BuildingVerificationCase`'s own list/assign/decide lifecycle) — there is no general-purpose staff view of all buildings, and no direct staff action on a building's own administrative status outside that queue.

A second, more concrete parallel to ADR-111's own finding: `BuildingRepository.updateBuildingStatus(buildingId, status)` already exists and already has real callers — `BuildingVerificationService`'s own decide flow (`APPROVE`/`REJECT`/`REQUEST_INFORMATION` → `VERIFIED`/`REJECTED`/`PENDING_INFORMATION`) and `FraudCaseService`'s `VERIFICATION_REVOCATION` enforcement effect (and its appeal-overturn reversal) — but there is no direct staff path to lock or reinstate a building's status that doesn't originate from one of those two case-based workflows, exactly mirroring the `reinstatePerson`/`suspendPerson` gap ADR-111 closed for `Person`. This stage closes the equivalent gap for `Building`: it gives `BUILDING_VIEW`/`BUILDING_EDIT` their first real endpoints, and gives staff a third, independent, always-audited caller of `updateBuildingStatus`.

## Decision — Permission Keys: Reuse, Don't Reinvent

No new `PermissionKey` enum value, no migration, in this stage — same decision ADR-111 made for `USER_VIEW`/`USER_EDIT`, for the same reason. `BUILDING_VIEW`/`BUILDING_EDIT` already exist, already have the correct view/mutate shape, and are already granted to exactly the roles this stage's endpoints should be reachable by (`Operations Admin` gets both; `Finance Admin`/`Support Admin` get read-only `BUILDING_VIEW`, which now actually resolves to something). Reusing them as-is is the smallest possible footprint for closing this gap, and finally gives two three-stage-old placeholder keys their first real meaning — the fourth and fifth such keys this roadmap has activated after `SYSTEM_SETTINGS`/`FEATURE_FLAGS` (ADR-109) and `USER_VIEW`/`USER_EDIT` (ADR-111).

## Decision — Endpoints

Four routes, added to the existing `BackOfficeModule` (the same module `BuildingVerificationController`/`UserAdministrationController` already live in):

- `GET /api/v1/backoffice/buildings` — paginated (`page`/`limit`, ADR-072 convention), with `search` (case-insensitive `contains` across name/addressLine/postalCode/city), `status` (exact-match `BuildingStatus` filter), and `hasRecoveryMode` (boolean filter on whether `recoveryModeEnteredAt` is set) filters. Gated `REVIEWER`+ (the lowest legacy rank) + `BUILDING_VIEW`.
- `GET /api/v1/backoffice/buildings/:buildingId` — profile fields, `status`, Recovery Mode, and current (`isCurrent: true`) memberships (id/personId/role/managerState/startedAt + basic person fields). Same gate as list. 404s on an unknown id.
- `POST /api/v1/backoffice/buildings/:buildingId/lock` — mandatory `reason`. Sets `status` to `REJECTED` via the pre-existing `BuildingRepository.updateBuildingStatus`. Gated `SENIOR_REVIEWER`+ + `BUILDING_EDIT`, matching `UserAdministrationController.suspend`'s own precedent for a consequential, entity-affecting mutation.
- `POST /api/v1/backoffice/buildings/:buildingId/reinstate` — mandatory `reason`. Sets `status` to `VERIFIED`. Same gate as lock.

`reason` is **mandatory** on both mutations (`@IsNotEmpty()`), per this engagement's own General Principles (Lock is explicitly one of the listed action types requiring a staff-supplied justification, alongside Suspend/Refund/Correction/Repair/Force Action).

Both mutations are deliberately simple and unconditional, matching `UserAdministrationService.suspend`/`reinstate`'s own precedent exactly: no guard against a concurrently-open `BuildingVerificationCase` or `FraudCase`, and no idempotency short-circuit — locking an already-`REJECTED` building (or reinstating an already-`VERIFIED` one) is a safe no-op with respect to the underlying field, but is still written and freshly audited, since a staff member re-affirming a status is real operational history. See Non-Goals and Consequences below for what this simplicity deliberately leaves unhandled.

### Why reuse `REJECTED`/`VERIFIED` instead of a new "locked" concept

`Building` has no boolean equivalent to `Person.isSuspended` — its administrative state is the six-value `BuildingStatus` enum, already the single source of truth every governance-feature gate (e.g. "requires a verified manager") and every existing status-mutating workflow (Building Verification's decide flow, Fraud Case's enforcement effect) already reads. Introducing a second, parallel "locked" flag alongside `status` would create two competing sources of truth for "is this building in good standing" with no defined precedence between them — exactly the kind of ungrounded, half-built concept this engagement's principles warn against. Reusing `REJECTED` (already the exact status Building Verification's own REJECT decision and Fraud Case's own revocation effect apply) and `VERIFIED` (already the exact status their own approve/reversal paths apply) keeps the vocabulary singular: **`Building.status` is the one place staff and every other domain reads "is this building in good standing," regardless of which workflow last changed it.** This stage's `lock`/`reinstate` therefore deliberately do **not** expose the other four `BuildingStatus` values (`PENDING`, `UNDER_REVIEW`, `PENDING_INFORMATION`, `MERGED`) as directly settable — those are transitional states owned by their respective workflows (initial submission, the verification queue, a merge operation), not values a direct administrative override should be able to jump to.

## Decision — Audit Trail, Distinct From the Verification/Fraud Paths

Two new audit actions: `BuildingLockedByAdmin`, `BuildingReinstatedByAdmin` — deliberately distinct from `BuildingVerificationService`'s own `BuildingVerificationDecided` and `FraudCaseService`'s own `EnforcementActionIssued`/`EnforcementActionAppealDecided`, even though all three paths ultimately call the same `BuildingRepository.updateBuildingStatus`. This lets an Audit Center reader always tell which workflow actually caused a given status change — the verification queue, a Fraud Case enforcement decision, or a direct staff override made through this new endpoint.

**Not** added to `ADR-110`'s `CRITICAL_AUDIT_ACTIONS` allowlist (the Operational Dashboard's recent-critical-events widget) — this is a deliberate deviation from what ADR-111's own text describes for `PersonSuspendedByAdmin`/`PersonReinstatedByAdmin`, and is called out explicitly here because investigating it surfaced a real, pre-existing discrepancy: **ADR-111 states both of its new action names "were added to `ADR-110`'s `CRITICAL_AUDIT_ACTIONS` allowlist," but `src/modules/dashboard/application/dashboard.service.ts`'s actual `CRITICAL_AUDIT_ACTIONS` array contains neither `PersonSuspendedByAdmin` nor `PersonReinstatedByAdmin` today.** This stage does not attempt to fix that mismatch — `dashboard.service.ts` belongs to Stage 3's already-Closed scope, and touching it here would violate this engagement's own "never touch out-of-scope files" principle for a change that is, at minimum, a one-line documentation correction to ADR-111 and, at most, a genuine small dashboard-visibility gap needing its own tiny reviewed change. This stage instead follows the **actual code precedent** (not the inaccurate ADR-111 prose) for consistency: neither this stage's two new actions nor ADR-111's own two are in that allowlist today. See Risks / Residual Debt below — this is flagged for the operator's own follow-up decision, not silently absorbed into this stage's scope.

## Decision — Detail View Does Not Duplicate the Verification/Fraud Case History

The detail endpoint deliberately does **not** include this building's own `BuildingVerificationCase`/`FraudCase` history inline. The Building Verification Queue and Fraud & Abuse Center already own that job with their own dedicated list/detail endpoints; duplicating either here would mean a second, narrower implementation of the same query. Same "reuse, don't reimplement another domain's job" discipline ADR-110 established for `systemHealth` and ADR-111 established for the Audit Center.

## Implementation

- `src/modules/backoffice/controller/building-administration.controller.ts` — the four routes.
- `src/modules/backoffice/application/building-administration.service.ts` — `list`, `getDetail`, `lock`, `reinstate`. Injects both `BackOfficeRepository` (list/search/detail) and `BuildingRepository` (the actual `updateBuildingStatus` mutation) — the same two-repository shape `BuildingVerificationService`/`FraudCaseService` already use.
- `src/modules/backoffice/application/dto/lock-building.dto.ts`, `reinstate-building.dto.ts` — both mandatory-`reason` DTOs.
- `src/modules/backoffice/infrastructure/repositories/backoffice.repository.ts` — three new methods: `findBuildingForAdminStatusChange` (existence + previous-status lookup, same shape as `findPersonForSuspensionState`), `searchBuildings` (list/search/filter, same `where`-with-`undefined`-keys convention `searchPersons` established), `getBuildingAdminDetail` (the detail query). `BuildingRepository.updateBuildingStatus` itself is unchanged — reused as-is, exactly as ADR-111 reused `suspendPerson`/`reinstatePerson` unchanged.
- `src/modules/backoffice/backoffice.module.ts` — the new controller/service added to the existing module's `controllers`/`providers` arrays. No new module import — `BuildingModule` was already imported (for `BuildingVerificationService`'s own `BuildingRepository` dependency).

No schema change, no migration, no seed change — `BUILDING_VIEW`/`BUILDING_EDIT` and their existing grants are reused exactly as they already were.

## Testing

- `src/modules/backoffice/application/building-administration.service.spec.ts` — `BackOfficeRepository`/`BuildingRepository`/`AuditService` all fully mocked. Covers: list/detail pass filters and pagination through unmodified and build pagination meta from the real total; `getDetail` 404s via `NotFoundAppError` on an unknown id; `lock`/`reinstate` both 404 on an unknown target (never touching `updateBuildingStatus` or audit in that case), write through to `BuildingRepository.updateBuildingStatus` with the correct target status, audit with the correct distinct action name and a `metadata.previousValue`/`newValue` pair, and remain idempotent (re-locking an already-`REJECTED` target still writes a fresh audit entry).
- `test/building-administration.e2e-spec.ts` — the first e2e coverage either `BUILDING_VIEW` or `BUILDING_EDIT` has ever had. Two independent 401/403×2/403-no-grant/granted-live/revoked-live blocks (one per permission key), plus a functional block against a real building created through the full `/buildings/setup/draft` + `/buildings/setup/submit` flow (a unique address hits the auto-approve path, so the fixture starts life genuinely `VERIFIED`): `search`/`page`/`limit` actually filter and paginate; the detail response's shape (profile fields, `status`, `memberships` array including the real founder's `OWNER` membership); a 404 on an unknown `buildingId`; a missing `reason` 400s (DTO validation); and the lock → reinstate round trip proving `status` actually flips `VERIFIED` → `REJECTED` → `VERIFIED` end to end via the detail endpoint's own subsequent reads.

## Build / Unit / E2E Verification

This stage introduces zero schema/migration changes, so no Prisma-client hand-patch of any kind was needed.

- `npx eslint` on every new/changed file — clean (one prettier-only formatting fix applied to `building-administration.service.ts`, `backoffice.repository.ts`, `building-administration.e2e-spec.ts`, and `e2e-identity.ts`, via `--fix`; the latter two fixes were pre-existing formatting drift on lines adjacent to, not introduced by, this stage's own edits).
- `npx tsc --noEmit` — **zero errors**, first attempt.
- `npm test` (full suite) — **577/577 passed, 47/47 suites**, including all 8 new `building-administration.service.spec.ts` tests, on the first run, with no bug found this time.
- `npm run build` — succeeded (after moving aside a stale `dist/` directory the mounted filesystem could not overwrite in place, the same recurring device-bridge quirk noted in ADR-110/ADR-111).
- `npm run test:e2e` was **not** run in this sandbox — this sandbox's `device_bash` shell has no reachable Postgres/Redis (established during ADR-110's own closure triage), so a real e2e run could not be executed here.

**The operator still needs to run the real verification stack** (`npm run build`, `npm test`, `npm run test:e2e`) on their own machine before this ADR can move to Closed.

## Non-Goals (Phase 1)

Explicitly out of scope for this ADR, listed exhaustively:

- Editing a Building's profile fields (name/address/unit counts/etc.) through this endpoint — `BUILDING_EDIT` here covers only the lock/reinstate administrative-status action; general profile editing (if ever needed as a staff action, as opposed to the manager/owner's own building-settings flow) is a separate concern with its own validation rules and was not requested for this stage.
- Directly setting `status` to any value other than `REJECTED`/`VERIFIED` (i.e. no general "set arbitrary status" endpoint) — see the "Why reuse `REJECTED`/`VERIFIED`" decision above for why the other four `BuildingStatus` values stay workflow-owned.
- A guard preventing `lock`/`reinstate` while a `BuildingVerificationCase` or `FraudCase` is concurrently open against the same building. This is a real, deliberately accepted gap (see Risks / Residual Debt) — this stage follows ADR-111's own precedent of a direct, unconditional, always-audited override rather than a workflow-aware transition.
- Adding `BuildingLockedByAdmin`/`BuildingReinstatedByAdmin` to `CRITICAL_AUDIT_ACTIONS` (see Decision above — `dashboard.service.ts` is out of this stage's scope; the discovered ADR-111 documentation/implementation mismatch is flagged for separate follow-up, not fixed here).
- A session/token or building-feature force-revocation action. Not applicable the way ADR-111's "force logout" non-goal was for `Person` — `Building.status` already gates the relevant governance/subscription features directly wherever they check it; there is no separate cached-state mechanism this stage would need to also invalidate.
- Inline verification/fraud case history on the detail view (see Decision above).
- Bulk actions (locking/reinstating more than one Building per request).
- A `sortBy`/`sortOrder` query parameter — following the same established convention `UserAdministrationController.list`/`SupportCaseController.list` already use (fixed `createdAt desc`).

## Risks / Residual Debt

- **No interaction guard with the Building Verification Queue or Fraud Case enforcement.** A staff member can `lock` a building that has an open `BuildingVerificationCase` (`decision: null`) or an active `FraudCase`, leaving that case's own queue entry pointing at a building whose status a different path already changed. This mirrors the same category of gap ADR-111 accepted for `Person` (no guard against a concurrent Fraud Case when suspending/reinstating directly), and is accepted here for the same reason: building a cross-workflow lock/consistency mechanism was not requested for this stage and would be a materially larger design surface than a direct administrative override.
- **Discovered ADR-111 documentation/implementation mismatch.** ADR-111's own text claims `PersonSuspendedByAdmin`/`PersonReinstatedByAdmin` were added to `CRITICAL_AUDIT_ACTIONS`; the actual array in `dashboard.service.ts` contains neither. Flagged here for the operator's own follow-up (either correct ADR-111's prose, or add all four action names — the two from ADR-111 and this stage's two — to the allowlist in one small, separately reviewed change against Stage 3's own file). Not fixed as part of this stage.

## Consequences

- Positive: `BUILDING_VIEW`/`BUILDING_EDIT` go from three-stage-old inert placeholders to real, tested, audited endpoints — the fourth/fifth such keys this roadmap has activated.
- Positive: staff gain a direct lock/reinstate path for a building's status that doesn't require opening a formal Building Verification Case or Fraud Case, closing a genuine functional gap this stage's own repo-state check discovered (the same shape of gap ADR-111 closed for `Person`).
- Positive: zero new npm dependencies, zero schema/migration changes.
- Neutral: `BuildingVerificationService`'s and `FraudCaseService`'s own status-mutation paths are completely unchanged — this stage adds a third, independent caller of `updateBuildingStatus`, not a replacement.
- Residual, tracked above: no cross-workflow consistency guard; the ADR-111 `CRITICAL_AUDIT_ACTIONS` documentation mismatch is flagged, not fixed.

## Future Review

- **Cross-workflow consistency guard.** If a lock/reinstate against a building with an open verification or fraud case turns out to cause real operational confusion, a future stage could add either a blocking check (reject the direct action while a case is open) or an informational one (surface "this building has an open case" in the response) — not built now since it wasn't requested and the direct-override precedent (ADR-111) argues against over-building it speculatively.
- **`CRITICAL_AUDIT_ACTIONS` reconciliation.** A small, separately reviewed change to `dashboard.service.ts` could add all four staff-direct-override action names (`PersonSuspendedByAdmin`, `PersonReinstatedByAdmin`, `BuildingLockedByAdmin`, `BuildingReinstatedByAdmin`) to the allowlist in one pass, correcting ADR-111's prose to match at the same time.
- **Profile-field editing / bulk actions / list sort order.** Same open questions ADR-111 already deferred for `Person`, now mirrored for `Building` — not designed now, revisited only if a real need for any of them surfaces.
