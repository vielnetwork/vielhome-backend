# ADR-102 — Backoffice Permission Migration Completion (Inventory + Matrix Phase)

**Status:** Accepted — Closed (2026-08-01)
**Context area:** 21_ADRs (Backend / Backoffice RBAC), Technical Debt Closure
**Related:** ADR-098 (Backoffice RBAC Foundation — Bridge Migration, Alternative C), ADR-099 (RBAC seed / `StaffRole` / `RolePermission` model), ADR-100 (Marketplace — first `PermissionsGuard` pilot), ADR-101 (Subscription Management — second pilot), ADR-107 (E2E cleanup discipline)

## Context

ADR-098/ADR-099 introduced a permission-driven authorization model (`Role` / `Permission` / `StaffRole` / `RolePermission`, resolved live per request by `PermissionResolverService`) that sits **alongside**, not in place of, the pre-existing `PlatformRolesGuard` (`PlatformStaffRole`: `REVIEWER` < `SENIOR_REVIEWER` < `PLATFORM_ADMIN`). ADR-100 (Marketplace) and ADR-101 (Subscription Management) each piloted attaching `PermissionsGuard`/`@RequiresPermission(...)` to one staff-facing controller without removing the legacy gate — both guards must pass. ADR-102 extended this to every remaining staff-facing Backoffice controller: `LegalHoldController`, `AuditController`, `FraudCaseController`, `BuildingVerificationController`, `ManagerVerificationController`, `SupportCaseController`, `ComplianceCaseController`, `PersonAccessController`, the Notification Template admin routes, `SchedulerController`, and `GamificationController`'s staff-only analytics route — one `<DOMAIN>_VIEW`/`<DOMAIN>_MANAGE` permission-key pair per domain (or a single key for small, uniform, `PLATFORM_ADMIN`-only domains like Legal Hold and Scheduler), reads mapped to `VIEW`, mutations mapped to `MANAGE`, `PlatformRoles` left exactly as before.

This closure review started from a question about whether ADR-102 could be considered done, given a apparent finding: `grep -L "PermissionsGuard" src/modules/backoffice/controller/*.ts` surfaced five file names with no occurrence of the string `PermissionsGuard`:

- `building-verification-appeal.controller.ts`
- `fraud-report.controller.ts`
- `manager-verification-owner.controller.ts`
- `subscription-report.controller.ts`
- `support-report.controller.ts`

This was initially treated as "five remaining unmigrated legacy staff controllers." It was not. This document records why that read was wrong, what the corrected verification found instead, and closes ADR-102 on the corrected basis.

## Root Cause of the False Positive

The initial grep checked only for the **absence** of one string (`"PermissionsGuard"`) inside one folder (`backoffice/controller/`). It never checked for the **presence** of `PlatformRolesGuard` — the actual legacy staff-authorization mechanism that ADR-102 exists to pair with `PermissionsGuard` — in those same files. It also implicitly assumed that every controller living in the `backoffice/controller/` folder is a staff-facing controller. Neither assumption holds.

This codebase groups controllers by **business domain**, not by **audience**. `fraud-case.controller.ts` (the staff queue) and `fraud-report.controller.ts` (a member filing a report, or a sanctioned Person appealing an enforcement action against themselves) sit in the same folder because they're both about fraud — not because they share an audience or a guard requirement. A folder-scoped, string-absence grep cannot distinguish "staff controller missing a guard" from "member-facing controller that never needed that guard." Any future audit of this kind must key off the actual guard applied, not the file's location or name.

## Corrected Verification Method

Re-ran across the entire `src` tree, keyed on the real legacy signal (`PlatformRolesGuard`) rather than folder or file name:

```bash
grep -rl "PlatformRolesGuard" src --include="*.controller.ts" | \
  while read f; do grep -q "PermissionsGuard" "$f" || echo "LEGACY-ONLY: $f"; done
```

Result: **exactly one file** —

```
LEGACY-ONLY: src/modules/backoffice-rbac/controller/rbac-management.controller.ts
```

None of the five originally-flagged files use `PlatformRolesGuard` anywhere. They were never staff-gated controllers to begin with, so they were never in scope for a `PermissionsGuard` pairing.

## Per-Controller Findings — the Five Originally-Flagged Files

Each is a deliberately member-facing / self-service counterpart to an already-migrated staff controller, confirmed by reading the controller's own code and doc comment:

- **`building-verification-appeal.controller.ts`** — `@UseGuards(JwtAuthGuard)` only. Own comment: "Deliberately `JwtAuthGuard` only (no `RolesGuard`/`MembershipGuard`): a rejected building may have no current Membership rows to check roles against, so the creator-check happens inside `BuildingVerificationPolicy.assertCanAppeal` instead." This is the building's own creator appealing their own rejection — not a staff action.
- **`fraud-report.controller.ts`** — `@UseGuards(JwtAuthGuard)` only. Own comment: "member-facing entry points: filing a fraud report, and a sanctioned Person appealing an enforcement action issued against them... the reporter/appellant may have no current, role-bearing Membership to check against the target being reported." Not a staff action.
- **`manager-verification-owner.controller.ts`** — `approve` uses `RolesGuard` + `@Roles('OWNER')` (a **building-scoped** Membership role, unrelated to `PlatformStaffRole`); `appeal` uses `JwtAuthGuard` only, for the same reason as the two controllers above. Neither route is staff-facing.
- **`subscription-report.controller.ts`** — `@UseGuards(JwtAuthGuard, MembershipGuard)` (any current building member). Own comment: "seeing what your building's plan unlocks is not a privileged action the way changing it is" — explicitly contrasted with the already-migrated staff route (`SubscriptionController`, `SUBSCRIPTION_VIEW`/`SUBSCRIPTION_MANAGE`) at a *different* path (`/backoffice/buildings/:buildingId/subscription` vs. this controller's `/buildings/:id/subscription`).
- **`support-report.controller.ts`** — `@UseGuards(JwtAuthGuard)` only. Own comment: "member-facing entry points: opening a ticket, viewing/replying to your own tickets, and reopening one... a reporter may have no building-scoped Membership relevant to a platform-level issue." Not a staff action.

Verdict for all five: **out of ADR-102 scope by design, not by omission. No production code changed.** Adding `PlatformRolesGuard`/`PermissionsGuard` to any of them would require a real `PlatformStaff` row to pass, which would lock out the ordinary members/owners/reporters these routes exist to serve — a regression, not a migration.

## `RbacManagementController` — a Deliberate Exception, Not a Gap

The one genuine `PlatformRolesGuard`-without-`PermissionsGuard` controller found by the corrected grep is, by its own doc comment, an intentional and still-necessary exception:

> "Bootstrap problem, deliberately resolved this way: these endpoints cannot be gated by the NEW permission system — nobody holds any permission through it yet ... so gating 'who can manage permissions' with the permission system itself would lock everyone out on day one. Gated instead by the EXISTING `PlatformRolesGuard` (`@PlatformRoles('PLATFORM_ADMIN')`) — the old system remains the authority over the new system's own administration for the duration of the Bridge Migration (21_ADRs > ADR-098 Alternative C)."

The risk this avoids is a genuine bootstrap deadlock: if the endpoints that grant/revoke `StaffRole`/`RolePermission` rows were themselves gated by the permission system those endpoints administer, then on any environment with zero `StaffRole` rows (a fresh seed, a disaster-recovery restore, a new environment), no one could ever grant the first permission — the system would be permanently locked out of its own administration. Keeping `RbacManagementController` on the legacy `PlatformRolesGuard` floor is what keeps that door open. This is confirmed correct and still required; it is not a leftover TODO.

## Post-Delivery Verification

- Final grep (repeated here verbatim as recorded evidence):
  ```
  $ grep -rl "PlatformRolesGuard" src --include="*.controller.ts" | \
      while read f; do grep -q "PermissionsGuard" "$f" || echo "LEGACY-ONLY: $f"; done
  LEGACY-ONLY: src/modules/backoffice-rbac/controller/rbac-management.controller.ts
  ```
- Concrete regression evidence for why the five member-facing controllers must stay untouched — `test/subscription.e2e-spec.ts:603-607`, already passing and unmodified:
  ```ts
  it('auto-creates a TRIAL/FREE subscription for every new building (04.04 Rule 7)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription`)
      .set('Authorization', `Bearer ${founder.accessToken}`)   // an ordinary founder, no PlatformStaff row
      .expect(200);
  ```
  Adding `PlatformRolesGuard`/`PermissionsGuard` to `SubscriptionReportController` would turn this existing, correct 200 into a 403 for every ordinary building founder — direct proof the member-facing design is load-bearing, not incidental.
- No production code, test code, or configuration was changed by this closure review — only this document was added. Build/unit/e2e status is therefore unchanged from the last full verification: `npm run build` ✓, `npm test` 506/506 ✓, `npm run test:e2e` 616/617 (the one remaining failure is the already-documented, isolated, non-reproducing `documents-storage.e2e-spec.ts` 25MB-ceiling transient — see ADR-107's "Isolated, unreproducible HTTP-status transients" entry, unrelated to this ADR). Re-running the full suite for a documentation-only change was judged unnecessary and was not done.

## Future Review — Conditions for Retiring the Bridge Migration

The dual-guard scheme (`PlatformRolesGuard` + `PermissionsGuard`, both must pass) and `RbacManagementController`'s legacy-only exception are both explicitly temporary, for "the duration of the Bridge Migration." Retiring either should wait until **all** of the following hold, not just some:

1. Every real production `PlatformStaff` row has a `StaffRole`/`RolePermission` grant set that is a proven superset of the rights its legacy `PlatformStaffRole` rank currently confers — a real parity audit against production data, not just test fixtures.
2. A non-circular bootstrap path exists for the *first* grant in any environment with zero `StaffRole` rows (e.g., a deploy-time migration/seed step that backfills `StaffRole` rows from existing `PlatformStaff.role` values) — this is the precondition for ever being able to gate `RbacManagementController` itself behind a permission (a new `RBAC_MANAGE` key, not yet defined).
3. A rollback path (feature flag or equivalent) exists in case the permission-only resolution has a defect post-cutover — removing the legacy floor removes today's safety net of requiring both checks to pass.
4. Sign-off that the Bridge Migration period has run long enough, and been audited enough in production, to trust cutting the legacy floor away entirely.

Until all four hold, both the dual-guard scheme and the `RbacManagementController` exception should remain exactly as they are.

## Recommendation — CI Guard Against Future Legacy-Only Staff Controllers

Investigated whether a reliable CI check can prevent a new staff-facing controller from ever shipping as legacy-only again. **Yes, but only if it keys off the actual guard applied, not file name, file path, or folder** — this closure review is itself proof that a name/folder heuristic produces false positives (flagged 5 member-facing files) while silently being capable of false negatives too (a staff controller placed outside the `backoffice/` folder would never have been checked at all by the original grep).

Proposed check, structurally identical to the corrected grep used in this review:

1. Find every `*.controller.ts` in `src` that applies `PlatformRolesGuard` (the unambiguous "this route requires real `PlatformStaff` rank" signal — this is what makes a route staff-facing, not its folder).
2. For each, require `PermissionsGuard` to also be present in the same file.
3. Any match failing that check must appear in a small, explicit, committed allowlist (e.g. `scripts/rbac-guard-exceptions.json` or a comment-documented array) where every entry names the controller and links to the ADR justifying the exception — currently that allowlist would contain exactly one entry: `RbacManagementController` → ADR-098 Alternative C / this document.
4. Fail CI on any `PlatformRolesGuard` file not paired with `PermissionsGuard` and not present in the allowlist.

Known limitation to flag before building this: the check as scoped above inspects guards at the controller-class level, matching every current example in this codebase (all `@UseGuards(...)` combinations here are declared once at the class level, not overridden per-method). If a future controller ever mixes route-level guard overrides with class-level ones, a plain grep would need to become an AST-aware check (walk each route handler's effective guard list, not just search file text) to stay accurate. Not needed today; worth remembering before assuming the simple version stays sufficient forever.

This check was not implemented as part of this closure review (documentation-only, per scope) — it is recorded here as a vetted, ready-to-build recommendation for whenever the team wants to add it to `npm run lint:ci`.

## Consequences

- Positive: ADR-102's actual scope — staff-facing Backoffice routes paired with `PermissionsGuard` — is confirmed complete. No further controller migration work is outstanding.
- Positive: the one real remaining `PlatformRolesGuard`-only controller (`RbacManagementController`) is confirmed to be a deliberate, still-valid exception, not a gap — closing the door on repeatedly re-discovering it as a "TODO."
- Positive: the false-positive mechanism (folder/file-name-scoped grep) is documented so it isn't repeated in a future audit.
- Neutral: no code changed. The five member-facing controllers and `RbacManagementController` remain exactly as they were.
- Residual, tracked for later (not closed here): the Bridge Migration retirement conditions (Future Review, above) and the CI guard (Recommendation, above) are both deliberately left as follow-up, not implemented in this closure.
