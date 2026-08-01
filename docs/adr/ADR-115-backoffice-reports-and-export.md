# ADR-115 — Backoffice Reports & Export

**Status:** Proposed — pending the operator's real build/unit/e2e verification run.
**Context area:** 21_ADRs (Backend / Backoffice), Reports & Export — Stage 8 of the Backoffice completion roadmap
**Related:** ADR-034 (Audit & Compliance Center's own CSV `export` route — the direct structural precedent this stage generalizes to four more domains), ADR-098/ADR-102 (Backoffice RBAC Foundation / Permission Migration Completion — this stage reuses, not extends, the permission matrix those ADRs already built), ADR-111/ADR-112/ADR-113/ADR-114 (User/Building/Financial/Notification Administration — Stages 4-7, the four `list` endpoints this stage adds a sibling `export` route to), ADR-110 (Operational Dashboard — Stage 3, real-time aggregate counts this stage's row-level CSV exports deliberately do not duplicate)

## Context

This is Stage 8 of the 10-stage Backoffice completion roadmap (Stages 1-7: Monitoring, Maintenance Mode/Feature Flags, Operational Dashboard, User/Building/Financial/Notification Administration, all Closed).

A real-repo-state check for this stage first confirmed there is **no dormant "Reports & Export" capability or permission key waiting to be wired** — unlike Stages 4-6, which each found a `PermissionKey` pair reserved since ADR-098 and never routed. Specifically:

- The `PermissionKey` enum's two report-sounding-adjacent identifiers found by an initial grep, `USER_REPORT` and `REPORTS`, are **not** permission keys at all: `USER_REPORT` is a `FraudCaseSource` enum value (a fraud case's origin — system-detected vs. user-filed), and `REPORTS` is a `SubscriptionFeatureKey` enum value (part of 04.04's Free/Pro feature matrix). Both were a false match from grepping a single large schema file for a bare word: confirmed by reading their actual enum blocks (`FraudCaseSource`/`SubscriptionFeatureKey`), not `PermissionKey`.
- Every real `PermissionKey` enum value that exists today is already wired to at least one route (`grep -rhoP "RequiresPermission\('\K[A-Z_]+" src/` lists all 33 in-use keys; the enum itself defines exactly those 33, zero unreferenced). Stages 1-7 have now activated every single reserved-but-unused pair ADR-098/ADR-102 originally set aside.
- The four controllers whose filenames contain the word "report" (`fraud-report.controller.ts`, `support-report.controller.ts`, `subscription-report.controller.ts`) are member-facing entry points misleadingly named after their source-document section numbers (07.03/07.05/07.04) — filing a fraud report, opening/replying to a support case, and viewing your own building's subscription, respectively. None is a staff-facing reporting/export surface, and none is touched by this stage.
- The one real existing export capability is `AuditController.export` (ADR-034) — a single CSV route, gated `AUDIT_VIEW`, that reuses the same permission as `AuditController.search` rather than a separate export-specific key. This is the only precedent for "Reports & Export" this codebase actually has, and it generalizes cleanly: every `list` route Stages 4-7 built (`GET /api/v1/backoffice/users`, `/buildings`, `/payments`, `/notifications`) already supports the same `search`/filter query params as `AuditController.search`, but none of them has an `export` sibling the way Audit does.

This stage closes that gap: it gives each of the four Stage 4-7 admin domains the same CSV export capability the Audit Center has had since ADR-034, and does so with the smallest possible footprint — no new `PermissionKey`, no migration, no seed change, no new module.

## Decision — Permission Keys: Reuse the Domain's Own VIEW Key, Not a New Export Key

No new `PermissionKey` enum value, no migration, in this stage — a first for a Backoffice-completion stage in the sense that even Stage 7 (ADR-114) needed two brand-new keys. Each new `export` route is gated by the **exact same** VIEW key that already gates that domain's own `list` route: `USER_VIEW`, `BUILDING_VIEW`, `FINANCE_VIEW`, `NOTIFICATION_DELIVERY_VIEW`. This is not a new design choice invented for this stage — it is the literal precedent `AuditController.export` already established for `AUDIT_VIEW` (ADR-034): a CSV export of a list is the same view capability in a different response shape, not a distinct privilege a role could plausibly want independently of the JSON list view. Anyone who can already see the full filtered/paginated JSON result set (subject to the exact same filters) gains nothing new in kind from also being able to download it as CSV — only a different transport format for data they were already authorized to read. Introducing a parallel `USER_EXPORT`/`BUILDING_EXPORT`/etc. key would fragment a single real capability into two grants for no behavioral reason, contradicting this codebase's own "no permission shared across domains, but no permission split within one either without a real distinction" discipline (see ADR-101's `SUBSCRIPTION_VIEW`/`MANAGE` boundary reasoning, applied here in the opposite direction — a boundary is not drawn where there is no real difference in what is being protected).

Dual-gate matches every other Backoffice route in this codebase: legacy `PlatformRolesGuard` floor at `REVIEWER`+ (identical to each domain's own `list`/`GET :id` rank) plus the same `RequiresPermission` key — the export route is declared with the identical `@PlatformRoles`/`@RequiresPermission` pair as its sibling `list` route in every controller.

## Decision — Endpoints

Four new routes, one per existing admin domain, always declared **before** that controller's own `:id`-param route (Nest matches routes in declaration order for the same HTTP method; `export` would otherwise be swallowed by `:personId`/`:buildingId`/`:paymentId`/`:deliveryId` as a literal id value):

- `GET /api/v1/backoffice/users/export` — same `search`/`isSuspended`/`isBackofficeApproved` filters as `list`, no pagination params (the export is a single capped dump, not a page). Gated `REVIEWER`+ + `USER_VIEW`.
- `GET /api/v1/backoffice/buildings/export` — same `search`/`status`/`hasRecoveryMode` filters as `list`. Gated `REVIEWER`+ + `BUILDING_VIEW`.
- `GET /api/v1/backoffice/payments/export` — same `search`/`status`/`buildingId` filters as `list`. Gated `REVIEWER`+ + `FINANCE_VIEW`.
- `GET /api/v1/backoffice/notifications/export` — same `search`/`status`/`channel`/`category` filters as `list`. Gated `REVIEWER`+ + `NOTIFICATION_DELIVERY_VIEW`.

Each route calls the exact same repository search method its sibling `list` route already calls (`searchPersons`/`searchBuildings`/`searchPayments`/`searchDeliveries`) with the same filter-building logic, `skip: 0` and a shared, capped `take` — **no new repository query is introduced**; this stage adds zero new Prisma queries, only a different `take`/output-shape on an existing one. The row cap (`DEFAULT_EXPORT_ROW_CAP = 5000`, `src/common/csv/csv.util.ts`) matches `AuditService.exportCsv`'s own pre-existing `take: filters.take ?? 5000` default exactly — the same "bounded bulk read, not a hard pagination contract" precedent, not a new number invented for this stage.

Response shape matches `AuditController.export` exactly: a non-passthrough `@Res()` handler (the global `ResponseInterceptor` must not wrap a CSV body in the standard JSON envelope), `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<domain>-export.csv"`.

## Decision — Shared CSV Utility, Extracted Rather Than Copy-Pasted a Fourth and Fifth Time

`src/common/csv/csv.util.ts` — a single `toCsv(rows, columns)` function providing the same header-row + RFC4180-style quote/comma/newline escaping `AuditService.exportCsv` already hand-rolled inline for its own one route. Copy-pasting that same ~15-line escape/join block into four more service files would be the third instance of exactly the pattern this roadmap's own General Principles discipline (no unnecessary duplication, once a pattern repeats) argues against tolerating. `AuditService.exportCsv`'s own inline implementation is deliberately **left untouched** — it is functionally identical, but refactoring a file this stage does not own is out of scope, matching this roadmap's own established discipline (Stage 7 did not touch the unrelated `governance.e2e-spec.ts` transient either). The new util also exports `DEFAULT_EXPORT_ROW_CAP` so the same cap value is defined once, not duplicated four times.

## Decision — Audit Trail: Every Export Is Logged, No Reason Required

Every export route calls `AuditService.record(...)` with a domain-specific action (`UserListExported`, `BuildingListExported`, `PaymentListExported`, `NotificationDeliveryListExported`), `actorId`, `requestId`, and `metadata: { filters, rowCount }` — the same "sensitive bulk data access is itself an auditable event" precedent `AuditController.export`'s own `AuditLogExported` action already established (07.06 Rule 017's "Sensitive Audit Access Must Be Audited," generalized here to the other three now-exportable domains). Unlike Suspend/Lock/Refund (Stages 4-6) or the roadmap's own general mandatory-reason list (Suspend/Lock/Refund/Correction/Repair/Force Action/settings changes), **export is a read, not a mutation** — no `reason` is required or accepted on any of the four new routes, matching `AuditController.export`'s own precedent (which likewise takes no `reason` param). The audit row exists to make bulk data access observable after the fact, not to gate it behind a justification.

## Decision — No New Data Leakage Surface

Every field in each CSV export is already returned, verbatim, by that domain's own pre-existing `list` JSON endpoint under the identical permission gate and the identical filter set — `searchPersons`/`searchBuildings`/`searchPayments`/`searchDeliveries` are called unchanged. CSV export therefore grants no reader access to any field, row, or filter combination they could not already reach via the JSON list endpoint; it only changes the transport format and removes the page-size cap in favor of a single larger bulk cap. No password hash, refresh token, internal id sequence, or any field absent from the existing `list` response is added to any export.

## Non-Goals (Phase 1)

- PDF or XLSX export (07.06 Rule 014's own "PDF is deferred" precedent for Audit export applies identically here — CSV only, for all four new routes).
- A cross-domain, single "Reports" landing page or a scheduled/recurring report generator — this stage is four narrow, symmetric additions to existing domains, not a new reporting subsystem. `ADR-110`'s own Operational Dashboard already owns real-time aggregate counts; this stage's CSVs are row-level detail dumps, a different and complementary concern, not a duplicate of it.
- Any new filter, sort, or field not already present on that domain's own `list` endpoint — export mirrors `list` exactly; it does not extend any domain's query surface.
- Streaming/chunked CSV generation for very large result sets — `DEFAULT_EXPORT_ROW_CAP = 5000` (matching Audit's own default) keeps every export a single in-memory string, consistent with `AuditService.exportCsv`'s own existing implementation; a true streaming export is deferred until a real need for >5000-row exports is demonstrated.

## Implementation

- `src/common/csv/csv.util.ts` — new file: `toCsv(rows, columns)`, `DEFAULT_EXPORT_ROW_CAP`.
- `src/modules/backoffice/controller/user-administration.controller.ts` — new `GET export` route (declared before `:personId`).
- `src/modules/backoffice/application/user-administration.service.ts` — new `exportCsv(filters, actorPersonId, requestId)`.
- `src/modules/backoffice/controller/building-administration.controller.ts` — new `GET export` route (declared before `:buildingId`).
- `src/modules/backoffice/application/building-administration.service.ts` — new `exportCsv(...)`.
- `src/modules/backoffice/controller/finance-administration.controller.ts` — new `GET export` route (declared before `:paymentId`).
- `src/modules/backoffice/application/finance-administration.service.ts` — new `exportCsv(...)`.
- `src/modules/notifications/controller/notification-administration.controller.ts` — new `GET export` route (declared before `:deliveryId`).
- `src/modules/notifications/application/notification-administration.service.ts` — new `exportCsv(...)`.

No new module, no `app.module.ts` change — every new route lives on a controller Stages 4-7 already registered.

## Schema / Migration / Seed

None. No new `PermissionKey`, no new model/field, no seed change — this is the first Backoffice-completion stage to require zero schema changes, a direct consequence of reusing each domain's own existing VIEW key rather than introducing an export-specific one.

## Testing

- Unit: `exportCsv` added to each of the four existing `*.service.spec.ts` files — covers CSV shape (header row + one data row from a mocked repository result), the row cap being passed through as `take` with `skip: 0`, and that `audit.record` is called once with the correct domain-specific action and `metadata.rowCount`.
- `src/common/csv/csv.util.spec.ts` — new file: header-only for an empty row set, comma/quote/newline escaping, `null`/`undefined` cells render as empty string, a `Date` cell renders as its own `toISOString()`.
- e2e: a new export block added to each of the four existing e2e spec files (`test/user-administration.e2e-spec.ts`, `test/building-administration.e2e-spec.ts`, `test/finance-administration.e2e-spec.ts`, `test/notification-administration.e2e-spec.ts`), placed between that file's own existing "returns 404 for an unknown id" test and its "revoking ... takes effect immediately" test — while the suite's `reviewer`/equivalent access token still holds the live VIEW grant from that file's own preceding test. Each new block: a 401 with no token, and a 200 with `content-type` containing `text/csv`, the exact expected header row, and the known fixture's id/value appearing in the body. A full independent 401/403×2/403-no-grant/granted/revoked permission matrix is **not** duplicated for the export route — it shares its permission key with the sibling `list` route, whose matrix already proves that key's guard behavior exhaustively; re-proving the same guard on a second route gated by the identical key would be redundant coverage, not additional confidence.

## Build / Unit / E2E Verification

This sandbox has no reachable Postgres/Redis of its own (the operator's own database is reached only via the device bridge, and long-running test commands exceed this sandbox's own tool timeout) — `npx eslint`/`npx tsc --noEmit` were run directly in-sandbox on every new/changed file; `npm test`/`npm run build`/`npm run test:e2e` must be run by the operator against their own real database. Because this stage introduces no schema change, **no migration step precedes this verification** — unlike every prior stage since ADR-110, the operator does not need to run `npx prisma migrate dev`/`npx prisma generate`/`npm run db:seed:rbac` before `npm run build && npm test && npm run test:e2e`.

This ADR is not Closed until that full sequence is confirmed green (or any failure has been triaged per the roadmap's own Verification Gate — isolated rerun, root-cause, compare against ADR-107's known patterns, before attributing anything to this stage).
