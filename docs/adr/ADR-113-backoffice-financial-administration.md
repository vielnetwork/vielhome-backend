# ADR-113 — Backoffice Financial Administration

**Status:** Accepted — Closed (2026-08-01)
**Context area:** 21_ADRs (Backend / Backoffice), Operational Readiness — Stage 6 of the Backoffice completion roadmap
**Related:** ADR-098 (Backoffice RBAC Foundation — reserved the `FINANCE_VIEW`/`FINANCE_REFUND` keys this ADR is the first to actually wire to a route), ADR-037 (Payment Reversal & Refund — `FinanceService.reversePayment`/`refundPayment`'s original, still-sole in-building caller, `FinanceController`), ADR-111/ADR-112 (User/Building Administration — Stage 4/5, the direct structural precedent this stage mirrors, with one deliberate deviation — see Decision below)

## Context

This is Stage 6 of the 10-stage Backoffice completion roadmap (Stages 1–5: Monitoring, Maintenance Mode/Feature Flags, Operational Dashboard, User Administration, Building Administration, all Closed). A real-repo-state check for this stage found the exact same shape of gap ADR-111/ADR-112 found for their own permission pairs: `FINANCE_VIEW`/`FINANCE_REFUND` — two `PermissionKey` values reserved since ADR-098 and already granted to `Finance Admin` in the seed matrix — have **never been wired to a single route** (confirmed by `grep -rn "RequiresPermission('FINANCE" src/` returning zero matches).

The existing Finance module (`src/modules/finance/`) is entirely building-scoped and gated by `RolesGuard`/`@Roles('MANAGER'|'ACCOUNTANT')` + `MembershipGuard` — a building member's own role, not `PlatformStaff`/`RequiresPermission`. A `Finance Admin` platform-staff member has no way to view a payment, let alone reverse or refund one, unless they also happen to hold a `MANAGER`/`ACCOUNTANT` membership in that specific building — which is a different, unrelated authorization system. There is no cross-building payment view anywhere in the codebase, and no staff-direct way to reverse or refund a payment outside the in-building workflow. This stage closes that gap: it gives `FINANCE_VIEW`/`FINANCE_REFUND` their first real endpoints, and gives Finance Admin staff a cross-building path to the same reversal/refund actions `FinanceController` already exposes to building managers.

## Decision — Permission Keys: Reuse, Don't Reinvent

No new `PermissionKey` enum value, no migration, in this stage — same decision ADR-111/ADR-112 made for their own reserved pairs. `FINANCE_VIEW`/`FINANCE_REFUND` already exist, already have the correct view/mutate shape, and are already granted to `Finance Admin` (whose own seed comment already names "Funds, Charges, Payments, Ledger" and "Issue adjustments/refunds" as its intended scope). This is the sixth and seventh such keys this roadmap has activated, after `SYSTEM_SETTINGS`/`FEATURE_FLAGS` (ADR-109), `USER_VIEW`/`USER_EDIT` (ADR-111), and `BUILDING_VIEW`/`BUILDING_EDIT` (ADR-112).

## Decision — Reuse `FinanceService`, Not Just `FinanceRepository` (a deliberate deviation from ADR-111/ADR-112's own pattern)

ADR-111's `UserAdministrationService.suspend`/`reinstate` and ADR-112's `BuildingAdministrationService.lock`/`reinstate` both call their target repository's raw mutation method directly (`BackOfficeRepository.suspendPerson`, `BuildingRepository.updateBuildingStatus`) — bypassing any higher-level domain service, since those mutations are simple, single-field writes with no other side effects to preserve.

Payment reversal/refund is materially different: `FinanceService.reversePayment`/`refundPayment` each own a real business-rule guard (`PaymentPolicy.assertReversible`/`assertRefundable`) **and** emit `PaymentReversedEvent`/`PaymentRefundedEvent`, which drive a real payer notification (`NotificationEventListenerService`) and a real Gamification score effect (`GamificationEventListenerService`). Calling `FinanceRepository.reversePayment`/`createRefund` directly, the way the two prior stages called their own target repository, would silently drop both of those effects for a staff-initiated action — a real functional regression a customer/payer would notice (no notification) that this stage must not introduce.

Instead, `FinanceAdministrationService.reverse`/`refund` call the full, already-tested `FinanceService.reversePayment`/`refundPayment` methods directly. To keep the Audit Center able to distinguish this staff-direct path from the in-building one (the same requirement ADR-111/ADR-112 satisfied with a distinctly-named audit action), `FinanceService.reversePayment`/`refundPayment` were given a small, purely additive `options?: { auditAction?: string }` trailing parameter: omitted (every existing call site, `FinanceController`'s own two routes), behavior is pixel-identical to before this stage; when passed `'PaymentReversedByAdmin'`/`'PaymentRefundedByAdmin'`, only the recorded audit action name changes — the policy check, repository mutation, and event emission are all untouched, so notification/gamification behavior is identical regardless of caller.

This is the one place this stage's design diverges from the exact shape of ADR-111/ADR-112, and it's called out explicitly here rather than silently copied, because uncritically porting "call the raw repository method" would have been the wrong call for this specific domain.

## Decision — Endpoints

Four routes, added to the existing `BackOfficeModule` (the same module `BuildingAdministrationController`/`UserAdministrationController` already live in):

- `GET /api/v1/backoffice/payments` — paginated (`page`/`limit`, ADR-072 convention), with `search` (case-insensitive `contains` across the payer's phone/full name or the payment's own `reference`/`note`), `status` (exact-match `PaymentStatus`), and `buildingId` (exact-match) filters. Gated `REVIEWER`+ + `FINANCE_VIEW`. The first payment query in the codebase with no building scope required — `FinanceRepository.listPayments`/`listPaymentsByUnit` are both single-building-scoped by design (the in-building module never needed anything broader).
- `GET /api/v1/backoffice/payments/:paymentId` — payment fields, basic building/payer context, and this payment's own refund history. Same gate as list. 404s on an unknown id. Deliberately does **not** include this building's own ledger/adjustment history — the in-building Finance module already owns that view (same "don't reimplement another domain's job" discipline ADR-110/ADR-111/ADR-112 already established).
- `POST /api/v1/backoffice/payments/:paymentId/reverse` — mandatory `reason` (new `AdminReversePaymentDto`, unlike the in-building `ReversePaymentDto`'s optional `reason`). Looks up the payment's `buildingId` via `FinanceRepository.findPaymentById` (building-unscoped), then delegates to `FinanceService.reversePayment`. Gated `SENIOR_REVIEWER`+ + `FINANCE_REFUND`.
- `POST /api/v1/backoffice/payments/:paymentId/refund` — reuses the in-building module's own `RefundPaymentDto` as-is (already mandatory `reason` + optional partial `amount` — exactly right, no need for a parallel DTO). Same gate as reverse.

## Decision — Audit Trail, Distinct From the In-Building Path

Two new audit actions: `PaymentReversedByAdmin`, `PaymentRefundedByAdmin` — deliberately distinct from `FinanceService`'s own `PaymentReversed`/`PaymentRefunded` (the in-building manager/accountant path), even though both paths now share the exact same method. This lets an Audit Center reader always tell which workflow actually caused a given reversal/refund. **Not** added to `ADR-110`'s `CRITICAL_AUDIT_ACTIONS` allowlist, following the same real-code-precedent (not ADR-111's own inaccurate prose) ADR-112 already flagged: neither `PersonSuspendedByAdmin`/`PersonReinstatedByAdmin` nor `BuildingLockedByAdmin`/`BuildingReinstatedByAdmin` are in that allowlist today, and `dashboard.service.ts` remains out of this stage's own scope. See ADR-112's own "Risks / Residual Debt" section for the standing reconciliation follow-up this stage adds two more names to.

## Implementation

- `src/modules/backoffice/controller/finance-administration.controller.ts` — the four routes.
- `src/modules/backoffice/application/finance-administration.service.ts` — `list`, `getDetail`, `reverse`, `refund`. Injects `BackOfficeRepository` (search/detail), `FinanceRepository` (the `findPaymentById` buildingId lookup), and `FinanceService` (the actual reversal/refund calls) — a three-dependency shape, one more than `BuildingAdministrationService`'s two, because this stage reuses a full domain service rather than a bare repository method.
- `src/modules/backoffice/application/dto/admin-reverse-payment.dto.ts` — the new mandatory-`reason` DTO for reverse.
- `src/modules/backoffice/infrastructure/repositories/backoffice.repository.ts` — two new methods: `searchPayments` (list/search/filter, same `where`-with-`undefined`-keys convention `searchBuildings`/`searchPersons` established), `getPaymentAdminDetail` (the detail query).
- `src/modules/finance/application/finance.service.ts` — `reversePayment`/`refundPayment` each gained the additive, optional `options?: { auditAction?: string }` trailing parameter described above. No existing call site changed; no existing behavior changed when the parameter is omitted.
- `src/modules/backoffice/backoffice.module.ts` — the new controller/service added to the existing module's arrays; `FinanceModule` added to `imports` (it already exports both `FinanceService` and `FinanceRepository` for its own reasons).

No schema change, no migration, no seed change — `FINANCE_VIEW`/`FINANCE_REFUND` and their existing grant to `Finance Admin` are reused exactly as they already were.

## Testing

- `src/modules/backoffice/application/finance-administration.service.spec.ts` — `BackOfficeRepository`/`FinanceRepository`/`FinanceService` all fully mocked. Covers: list/detail pass filters and pagination through unmodified; `getDetail` 404s via `NotFoundAppError` on an unknown id; `reverse`/`refund` both 404 on an unknown payment (never touching `FinanceService` in that case), otherwise look up the payment's `buildingId` and delegate to `FinanceService.reversePayment`/`refundPayment` with the correct `PaymentReversedByAdmin`/`PaymentRefundedByAdmin` override — proving this service never bypasses `FinanceService` to call `FinanceRepository.reversePayment`/`createRefund` directly.
- `test/finance-administration.e2e-spec.ts` — the first e2e coverage either `FINANCE_VIEW` or `FINANCE_REFUND` has ever had. Two independent 401/403×2/403-no-grant/granted-live/revoked-live blocks, plus a functional block against two real, `APPROVED` payments created through the full in-building Finance flow (charge batch issued, payment reported and approved by a `MANAGER` founder — the same "founder holds every Finance-gated role this suite needs" convention `finance.e2e-spec.ts` itself established, since no API path grants a real `ACCOUNTANT` membership): `search`/`page`/`limit` actually filter and paginate; the detail response's shape; a 404 on an unknown `paymentId`; a missing `reason` 400s on reverse; the reverse action flips `status` to `REVERSED` (verified via a direct `prisma.payment.findUnique` read, the same technique `finance.e2e-spec.ts` itself uses for this exact assertion) and records `PaymentReversedByAdmin` with the real reason; a second reverse attempt on the now-`REVERSED` payment correctly 422s (`BUSINESS_RULE_VIOLATION`, proving `PaymentPolicy.assertReversible` still runs); and the refund action creates a real `Refund` row, flips `status` to `REFUNDED`, and records `PaymentRefundedByAdmin`.

## Build / Unit / E2E Verification

This stage introduces zero schema/migration changes, so no Prisma-client hand-patch of any kind was needed.

- `npx eslint` on every new/changed file — clean, first attempt (no fixes needed).
- `npx tsc --noEmit` — **zero errors**, first attempt.
- `npm test` (full suite) — **584/584 passed, 48/48 suites**, including all 7 new `finance-administration.service.spec.ts` tests, on the first run, with no bug found this time.
- `npm run build` — succeeded (after moving aside a stale `dist/` directory the mounted filesystem could not overwrite in place, the same recurring device-bridge quirk noted since ADR-110).
- `npm run test:e2e` was **not** run in this sandbox — no reachable Postgres/Redis in this sandbox's `device_bash` shell (established during ADR-110's own closure triage).

**The operator ran the real verification stack** (`npm run build`, `npm test`, `npm run test:e2e`) on their own machine:

## Final Verification (Closure Gate)

- `npm run build` — succeeded.
- `npm test` (full suite) — **584/584 passed, 48/48 suites**.
- `npm run test:e2e` (first real run) — **698/698 passed, 28/28 suites, zero failures**, including
  `test/finance-administration.e2e-spec.ts` itself and every other suite. No bug found, no unrelated
  transient observed — the second consecutive clean first-pass closure in this roadmap (after
  ADR-112's own post-fix re-run), and the first stage where the *initial* real e2e run itself came
  back fully green with no fix cycle needed at all.

ADR-113 is CLOSED on this basis: its own code and both test suites (unit + e2e) are fully green.

## Non-Goals (Phase 1)

Explicitly out of scope for this ADR, listed exhaustively:

- Editing/creating Funds, Charge Batches, Adjustments, or Ledger entries through a Backoffice-facing route — `FINANCE_REFUND` here covers only the reverse/refund actions `FinanceController` already exposes in-building; a cross-building Fund/Adjustment admin surface is a separate concern with its own design questions (e.g. which building's Fund a cross-building Adjustment would even post to) and was not requested for this stage.
- A `FINANCE_MANAGE`/write-off/force-correction action beyond reverse/refund. The roadmap's own General Principles list "Correction"/"Force Action" among example action types — this stage covers the two staff-direct actions that already have a real, tested underlying mechanism (`FinanceService.reversePayment`/`refundPayment`); a distinct write-off concept with no existing mechanism to reuse would be exactly the kind of ungrounded, half-built endpoint this engagement's principles warn against.
- Adding `PaymentReversedByAdmin`/`PaymentRefundedByAdmin` to `CRITICAL_AUDIT_ACTIONS` (see Decision above — `dashboard.service.ts` is out of this stage's scope; flagged as an addition to ADR-112's own reconciliation follow-up, not fixed here).
- Inline ledger/adjustment history on the detail view (see Decision above).
- Bulk actions (reversing/refunding more than one payment per request).
- A `sortBy`/`sortOrder` query parameter — following the same established convention every prior stage's list endpoint already uses (fixed `createdAt desc`).

## Risks / Residual Debt

- **`CRITICAL_AUDIT_ACTIONS` reconciliation now has four (not two) names waiting.** ADR-112 already flagged `PersonSuspendedByAdmin`/`PersonReinstatedByAdmin`/`BuildingLockedByAdmin`/`BuildingReinstatedByAdmin` as absent from that allowlist despite ADR-111's prose claiming otherwise; this stage adds `PaymentReversedByAdmin`/`PaymentRefundedByAdmin` to that same waiting list. A single small, separately reviewed change to `dashboard.service.ts` could reconcile all six at once.
- **No guard against reversing/refunding a payment whose building has since been locked (ADR-112) or is under an open Fraud Case.** This stage's `reverse`/`refund` go through the exact same `FinanceService` methods and policy checks the in-building path already uses, so payment-level invariants (status transitions, refund-amount bounds) are fully enforced — but there is no cross-domain check like "is this building currently locked by Backoffice." Accepted for the same reason ADR-111/ADR-112 accepted their own analogous gaps: not requested for this stage, and a materially larger design surface than a direct administrative override.

## Consequences

- Positive: `FINANCE_VIEW`/`FINANCE_REFUND` go from three-stage-old inert placeholders to real, tested, audited endpoints — the sixth/seventh such keys this roadmap has activated.
- Positive: Finance Admin staff gain a cross-building payment view and a direct reverse/refund path that doesn't require holding a building-level `MANAGER`/`ACCOUNTANT` membership, closing a genuine functional gap this stage's own repo-state check discovered.
- Positive: zero new npm dependencies, zero schema/migration changes.
- Positive: the additive `options.auditAction` parameter on `FinanceService.reversePayment`/`refundPayment` means payer notifications and Gamification score effects fire identically regardless of whether a reversal/refund originated in-building or from this new staff-direct path — no regression, no duplicated event-emission logic to keep in sync over time.
- Neutral: `FinanceController`'s own two routes are completely unchanged — this stage adds a second, independent caller of the same two service methods, not a replacement.
- Residual, tracked above: the `CRITICAL_AUDIT_ACTIONS` reconciliation now covers six names; no cross-domain "is this building locked" guard.

## Future Review

- **`CRITICAL_AUDIT_ACTIONS` reconciliation.** Now covers six names across three stages (see Risks above) — the longer this waits, the more names accumulate; a good candidate for the very next small, standalone doc/code-consistency pass.
- **Cross-building Fund/Adjustment/Ledger administration.** If a future requirement needs staff to act on Funds or Adjustments directly (not just Payments), it deserves its own design pass — the building-scoping questions a cross-building Fund action raises are different from a single Payment's already-unambiguous `buildingId`.
- **Cross-domain consistency guards.** Same open question ADR-111/ADR-112 already deferred, now mirrored for Finance — not designed now, revisited only if a real operational need surfaces (e.g. a locked building's payments still being reversible turning out to cause real confusion).
