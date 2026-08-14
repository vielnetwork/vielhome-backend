# ADR-119 — Finance ↔ Mobile Pagination Contract Alignment

**Status:** Accepted — Closed (2026-08-02)
**Context area:** 21_ADRs (Backend + Mobile), Finance module — closes a mobile-compatibility gap the Finance Hardening Pass (post-audit) itself introduced and disclosed
**Related:** ADR-072 (the platform's shared `page`/`limit` pagination contract, `src/common/pagination`, `08_API_Architecture`) — this ADR is the first time a consumer of that contract (Finance's mobile client) is actually updated to read it correctly; Finance Hardening Pass / post-audit report (added pagination to Finance's seven list endpoints, the gap this ADR closes); ADR-094 (Fund Reconciliation, Sprint 29 — the mobile Funds surface this ADR also migrates); ADR-120 (Platform Pagination & Idempotency Hardening backlog — the platform-wide items explicitly deferred out of this ADR's scope)

## Context

The Finance Hardening Pass (post-audit) added `page`/`limit` pagination to Finance's seven previously-unbounded list endpoints (`listFunds`, `listChargeBatches`, `listUnitChargeItems`, `listUnitPayments`, `listUnitAdjustments`, `listPayments`, `listLedger`), per the platform's shared `ADR-072` contract. That work was correct and necessary on the backend, but it was disclosed at the time as introducing a mobile-compatibility gap: the Flutter app's `finance_api.dart`/`ApiClient` never read the response envelope's `metadata.pagination` block at all — it only ever consumed `data`, discarding `metadata` outright. A building or unit with more than `DEFAULT_PAGE_LIMIT` (20) rows of any Finance list would silently show only its first page on mobile, with no error and no visible truncation indicator.

The highest-risk consumer of this gap was `pendingPaymentsProvider`: it called `listPayments` with no filter and filtered to `PENDING_APPROVAL` client-side. Once a building accumulated roughly 20 payments of *any* status more recently than a still-pending one, that pending payment fell off page 1 and disappeared from the reviewer queue entirely — silent data loss for the person who most needed to see it. A second-order symptom made this worse: `PaymentDetailScreen` looks up its target payment by `id` out of that same cached list (there is no `GET /payments/:paymentId` route), so once a pending payment fell off the list, its detail screen showed "Already Reviewed" — actively incorrect, not just an omission.

A full investigation (technical review, `finance-pagination-mobile-review` report) traced every paginated Finance endpoint to its Flutter consumer and confirmed the failure mode, severity, and blast radius per screen before any code was written. A design plan (`finance-pagination-contract-alignment-plan`) then proposed the fix architecture across Backend and Mobile before implementation began, per this project's own ADR-review-discussion-approval-implementation lifecycle (`21_ADRs`).

## Decision — Root-Cause Fix for Pending Payments: A Real Server-Side `status` Filter

`GET /buildings/:buildingId/payments` gained an optional `status` query param, validated against the real `PaymentStatus` enum (`PENDING_APPROVAL | APPROVED | REJECTED | REVERSED | REFUNDED`) — an unrecognized value 400s with `VALIDATION_ERROR` rather than being silently ignored. `FinanceRepository.listPayments`'s `where` clause conditionally includes `status` when provided, reusing the **pre-existing** `@@index([buildingId, status])` composite index confirmed in `prisma/schema.prisma` — zero migration, zero schema change, zero breaking change to any existing caller that omits the param. `pendingPaymentsProvider` now passes `status: 'PENDING_APPROVAL'` instead of fetching everything and filtering client-side, which closes the bug at its root: only pending rows ever occupy this query's paginated window in the first place, so a still-pending payment can no longer fall off page 1 regardless of how many other payments of any other status were reported more recently. This was judged the cleanest of the alternatives considered (A: teach Flutter to paginate and keep filtering client-side across every page — more client complexity for the same end state; B: temporarily exempt Finance from pagination — reintroduces the original unbounded-response risk ADR-072/the Hardening Pass exists to prevent; C: this server-side filter, chosen).

## Decision — Canonical Mobile Pagination Primitives, Added to `core/network`

`PaginatedResult<T>` (`lib/core/network/paginated_result.dart`) and `ApiClient.getPaginated<T>()` (additive to `api_client.dart`, alongside the existing `get<T>` — untouched, all ~20 existing call sites unaffected) are the new canonical primitives for consuming `ADR-072`'s envelope shape on mobile. `getPaginated<T>` mirrors `get<T>`'s exact request/error/offline-cache-fallback behavior, reading `metadata.pagination` into a `PaginatedResult<T>` (`items`/`page`/`limit`/`total`/`totalPages`, plus a `hasMore` getter that guards the backend's own empty-collection `totalPages: 1` quirk). These are deliberately generic over any feature — not Finance-specific — so Marketplace's own already-disclosed identical gap (`browseProviders()`'s hand-rolled `limit: 50` stopgap) can adopt them unchanged later, per this ADR's own narrowed scope (see Non-Goals).

## Decision — Per-Screen Pagination Strategy, Not One-Size-Fits-All

Finance's remaining screens were evaluated individually rather than given a single blanket treatment:

- **Pending Payments / Funds**: bounded internal auto-paginate loops (capped at 50 pages / ~1000 rows) inside `pendingPaymentsProvider`/`fundsListProvider`, still resolving to a flat `List<Map<String, dynamic>>` — chosen because both queues are operationally bounded in practice (a reviewer backlog or a building's Fund count), and because resolving to the same flat-list shape means `PendingPaymentsScreen`, `PaymentDetailScreen`, and `FundsListScreen` needed **zero changes** to their own code.
- **Unit Finance's charge-item and payment history**: a unit's history can genuinely exceed one page over a multi-year tenancy, so this is the one place given real UI pagination — a new `UnitHistoryController` (`features/finance/application/finance_providers.dart`) with a "Load more" affordance, backing two new providers (`unitChargeItemsHistoryProvider`, `unitPaymentsHistoryProvider`). `unitFinanceProvider` was narrowed to just the debt breakdown; the old combined `UnitFinanceBundle` was removed.

## Non-Goals

- **Marketplace was not migrated.** `PaginatedResult<T>`/`getPaginated<T>` are generic enough for it to adopt unchanged later; its own `limit: 50` stopgap is untouched by this ADR, per the explicit instruction narrowing this pass to Finance only.
- **No platform-wide deterministic-ordering hardening.** All 19 paginated repository methods surveyed platform-wide (Finance: 8, BackOffice: 9, Marketplace: 2, Notifications: 1) lack a unique secondary sort key (`orderBy: [{createdAt:'desc'},{id:'desc'}]`). This is a real, confirmed gap — deliberately not partially fixed in Finance alone here. See ADR-120.
- **No generic `core/pagination` controller/widget framework.** `UnitHistoryController` is Finance-scoped (`features/finance/application/`), not `core/`, per the explicit instruction to finish Finance cleanly before expanding the pagination framework platform-wide. It is written generically enough internally (parameterized by a page-fetch callback) to be lifted into `core/pagination` unchanged whenever that platform-wide pass happens.
- **No cursor pagination.** The existing offset (`page`/`limit`) contract is unchanged and extended, not replaced. See ADR-120 for why cursor pagination is a separate, deliberately-deferred question.
- **No idempotency-key convention.** Unrelated to this ADR's scope; tracked as its own deferred item in ADR-120.

## Implementation

**Backend:**
- `src/modules/finance/controller/finance.controller.ts` — `listPayments` accepts and validates optional `?status=`.
- `src/modules/finance/application/finance.service.ts` — `listPayments` passes `status` through unchanged.
- `src/modules/finance/infrastructure/repositories/finance.repository.ts` — `listPayments`'s `where` conditionally includes `status`; reuses the existing `(buildingId, status)` index.

**Mobile:**
- `lib/core/network/paginated_result.dart` — new, canonical `PaginatedResult<T>`.
- `lib/core/network/api_client.dart` — new `getPaginated<T>()`, additive.
- `lib/features/finance/infrastructure/finance_api.dart` — `listPayments`, `listFunds`, `listUnitChargeItems`, `listUnitPayments` converted to `getPaginated`; `listPayments` gained an optional `status` param.
- `lib/features/finance/application/finance_providers.dart` — `pendingPaymentsProvider`/`fundsListProvider` rewritten as bounded auto-paginate loops; `unitFinanceProvider` narrowed to debt only; new `UnitHistoryController`, `unitChargeItemsHistoryProvider`, `unitPaymentsHistoryProvider`.
- `lib/features/finance/presentation/screens/unit_finance_screen.dart` — rewritten to drive both history sections from the new paged controllers with a "Load more" row.
- `lib/l10n/app_{en,fa,tr}.arb` + generated `app_localizations*.dart` — new `commonLoadMore` string.

## Testing

- Backend: +2 `finance.service.spec.ts` tests, +3 `finance.repository.spec.ts` tests, +5 `test/finance.e2e-spec.ts` tests (no filter / `PENDING_APPROVAL` filter / `APPROVED` filter / invalid status 400s / status + pagination metadata combine correctly).
- Mobile: new `test/finance_pagination_test.dart` (8 tests) — `pendingPaymentsProvider` walks every page and flattens the queue, stops after one page when there's no more, resolves to an empty list without looping forever on the backend's own empty-collection `totalPages: 1` quirk; `fundsListProvider` walks every page; `UnitHistoryController` loads page 1 on construction and accumulates on `loadMore()`, is a no-op past the last page, and surfaces a failed `loadMore()`'s error without discarding items already loaded.
- Two pre-existing mobile test fixtures (`payment_review_controller_test.dart`, `charge_batch_create_controller_test.dart`) had local `FakeFinanceApi implements FinanceApi` fakes updated to the new method signatures — required maintenance, not new coverage.

## Build / Unit / E2E Verification

Two real defects were found and fixed during the operator's own `flutter analyze`/`flutter test` runs (not caught by the sandbox, which has no Flutter/Dart toolchain available at all):
1. `finance_pagination_test.dart`'s `FakeFinanceApi` passed `chargeItemsErrorOnCallNumber` into its constructor without that being a declared constructor parameter — a compile error. Fixed by adding it to the constructor.
2. Three new `UnitHistoryController` tests read the controller from an `.autoDispose` provider without establishing a durable listener, so Riverpod disposed it before the test's `await settle()` (a real `Timer`-based delay) ran — "Bad state: Tried to use ... after `dispose` was called," the exact same pitfall `payment_review_controller_test.dart`'s own `_readController` helper already documents and works around. Fixed with the same `container.listen(provider, (_, __) {}, fireImmediately: true)` pattern.

15 `require_trailing_commas` lint infos (this repo's own lint convention) in the same new test file plus one spot in `api_client.dart`'s `getPaginated` were also cleaned up to match the rest of the codebase.

## Final Verification (Closure Gate)

The operator ran the real verification sequence on the actual dev/mobile toolchain and confirmed:

- `npx prisma validate`: passed.
- `npm run build`: passed.
- `npm test` (backend unit): passed (702/702, 56 suites, confirmed twice — once in-sandbox by the assistant, once by the operator).
- `npm run test:e2e`: **773/773 passed, 32/32 suites** (up from the prior confirmed baseline of 768/768 at the close of the Finance Hardening Pass — the +5 delta is exactly the 5 new `Payment Status Filter` tests in `test/finance.e2e-spec.ts`, with no other suite's count changed).
- `flutter analyze`: **No issues found** (after the two fixes above).
- `flutter test`: passed (after the two fixes above).
- Manual verification (Pending Payments, Payment Detail, Funds, Unit Finance) using seed data exceeding the default page size (20): confirmed by the operator — every pending payment visible regardless of newer approved/rejected payments, filtering confirmed server-side, Payment Detail never incorrectly shows "Already Reviewed," every Fund reachable and selectable in Charge Batch creation, Unit Finance's Load More accumulates without duplicates or missing rows, debt totals and ordering unaffected.

ADR-119 is closed. No further action is pending for Finance.

## Consequences

- Positive: closes real, previously-disclosed silent data loss in the highest-risk Finance mobile screen (Pending Payments) and an actively-incorrect status display (Payment Detail's "Already Reviewed" misfire) — both now provably impossible under normal operation, not just less likely.
- Positive: `PaginatedResult<T>`/`ApiClient.getPaginated<T>` are now real, tested, reusable primitives in `core/network` — the next module to need real pagination (Marketplace, or a future platform-wide pass) does not start from zero.
- Positive: zero backend migration, zero schema change, zero breaking API change — the smallest possible backend footprint for the fix it delivers.
- Neutral: `UnitHistoryController` is intentionally Finance-scoped rather than promoted to `core/`, so Marketplace's own pagination migration will still need its own controller wiring (though it can reuse `PaginatedResult`/`getPaginated` unchanged) — a deliberate scope boundary, not an oversight (see Non-Goals and ADR-120).
- Negative/accepted: Marketplace's `browseProviders()` `limit: 50` stopgap remains unfixed; deterministic ordering remains platform-wide unaddressed. Both are explicitly tracked, not silently dropped — see ADR-120.

## Future Review

- Marketplace pagination migration — adopt `PaginatedResult`/`getPaginated` unchanged; see ADR-120.
- Platform-wide deterministic ordering hardening (Finance, Marketplace, BackOffice, Notifications together) — see ADR-120.
- A generic `core/pagination` controller/widget framework, generalizing `UnitHistoryController`'s shape — worth building once a second feature (Marketplace) has a genuine multi-page UI-pagination need, not speculatively now.
