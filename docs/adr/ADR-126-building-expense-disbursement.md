# ADR-126 — Building Expense / Disbursement (FIN-EXP-01/FIN-EXP-02)

**Status:** Accepted
**Date:** 2026-08-16
**Scope:** Backend Finance module — new `Expense` capability. Mobile and Backoffice Web are out of scope for this ADR (backend-only slice; see FIN-EXP-01 design doc for the full Mobile/Backoffice preview).

## Context

The Mobile MVP Gap Audit (`docs/audit/MOBILE-MVP-GAP-AUDIT.md`, finding `MOB-GAP-01`) identified that VielHome's backend had no concept of a building operating expense — money the building spends (a cleaning contractor, a utility bill, elevator maintenance). `Charge` represents money units owe, `Payment` represents money received from a payer; neither can represent an outgoing, building-initiated cost without corrupting its own meaning (`getFinancialSummary`'s `totalCollected`/`getCollectionRate` both assume `Payment` is payer-side cash in). A Manager had no way to record this at all — not even a Backoffice-staff fallback existed, unlike several other MVP gaps the audit found.

`FIN-EXP-01` (`docs/audit/FIN-EXP-01-EXPENSE-CONTRACT-DESIGN.md`) audited the existing Finance architecture and designed the smallest additive capability that plugs into the existing Ledger/Fund mechanism without touching Charge, Payment, or unit debt. This ADR records the resulting decision as implemented by FIN-EXP-02.

## Decision

### Product contract

- `Expense` = money the building spent. Distinct from `Charge` (money units owe) and `Payment` (money received). Creating an Expense never creates a Charge, never changes any unit's debt, and is never represented as a Payment.
- An Expense affects the relevant `Fund`'s balance only through a real, append-only `EXPENSE` `LedgerEntry` — the same mechanism every other cash movement in this module already uses. `Fund.balance` is never written directly.
- Expense is immutable after creation. The only correction path is **VOID** (with a mandatory reason) plus a fresh, correct Expense — never an edit, matching every other posted Finance record's correction convention (`reversePayment`, `createRefund`, `Adjustment`).
- Write roles: `MANAGER`, `ACCOUNTANT` (same pairing as Adjustment create and Payment reverse/refund). Read: any current building member (`MembershipGuard`), matching every other Finance read.
- Receipts/attachments are optional and non-blocking: `EXPENSE` was added to `DocumentReferenceEntityType`, reusing the existing polymorphic `DocumentReference` mechanism with zero new coupling.

### Data model

New `Expense` model (`prisma/schema.prisma`): `id, buildingId, fundId, title, description?, category (ExpenseCategory), amount (Int, Rial — ADR-125), occurredAt, status (ExpenseStatus: POSTED|VOIDED), createdById, voidedAt?, voidedById?, voidReason?, idempotencyKey? (unique), createdAt, updatedAt`. Indexed on `buildingId`, `fundId`, `[buildingId, status]`, `[buildingId, category]`.

`ExpenseCategory`: `UTILITIES, CLEANING, MAINTENANCE, REPAIR, ELEVATOR, SECURITY, INSURANCE, ADMINISTRATION, OTHER` — a fixed enum (not a per-building free-form list), matching `FundType`/`ChargeUnitScope`'s own growth-by-addition precedent and supporting stable "expense by category" reporting.

`LedgerEntryType` gained `EXPENSE`. `affectsFundBalance()` (`finance.repository.ts`) was extended to include it — real cash leaving the fund, decremented on create, restored (incremented) by a `CREDIT` counter-entry on void, mirroring `REVERSAL`'s "reversal creates counter entry" convention rather than mutating or deleting the original entry.

### Transaction design

`createExpense`: re-reads `fund.balance` **inside** the transaction (not the service layer's pre-fetched copy) and rejects if it would drive the balance negative (`BusinessRuleViolationError`, 422) — a fund cannot spend cash it doesn't hold, unlike a resident debt waiver which may leave residual unmet debt. Then creates the `Expense` row, a `DEBIT` `EXPENSE` `LedgerEntry`, and decrements `Fund.balance`, all in one `prisma.$transaction`.

`voidExpense`: uses the same "expected-status" CAS pattern `VotingRepository.closeVote`/`CaseRepository.resolveCase`/`closeCase` already establish — `tx.expense.updateMany({ where: { id, status: 'POSTED' } })`, checking `count === 1`, throwing `ConflictError` (409) if a concurrent void already won the race. This is deliberately stronger than a plain pre-fetched-then-conditionally-written check (the pattern this module uses for e.g. `FundPolicy.assertActive`): a lost void race here would otherwise post a second CREDIT counter-entry and double-credit `Fund.balance`, corrupting real money, not just producing a stale UX message. The service layer still runs a fast, friendly `ExpensePolicy.assertVoidable` pre-check first for the common non-racy case (422), with the repository's CAS as the sole authoritative guard for genuine concurrency — the same fast-pre-check/authoritative-CAS split `VotingService.closeVote`/`cancelVote` already establish.

### Idempotency

`Expense.idempotencyKey` is an optional, client-supplied, DB-unique field — the same `String? @unique` shape as the Fraud module's `EnforcementAction.idempotencyKey`, the only prior true DB-level idempotency precedent in this codebase (`LedgerEntry`/`AuditLog`'s `requestId` is a plain nullable tracing field, not unique-enforced). A retried request with the same key catches the resulting `P2002` violation and returns the original Expense instead of raising — the same pattern `applyLateFee` already uses for `Adjustment`'s `sourceType`/`sourceId` race.

### Reporting

`getFinancialSummary` gained `totalExpenses` — the sum of `POSTED` Expenses for the building (a `VOIDED` Expense's cash effect was already reversed by its own counter LedgerEntry, so including it would double-subtract).

## Consequences

Benefits:

- Managers/Accountants can now record real building spend without any workaround; the exact `MOB-GAP-01` gap is closed at the backend layer.
- Zero coupling to Charge/Payment beyond sharing `Fund`/`LedgerEntry`, so `getCollectionRate`/`totalCollected`'s payer-side semantics stay intact.
- `Fund.balance`'s "always reconstructable by replaying LedgerEntry" invariant holds for Expense exactly as it does for every other entry type.
- Concurrent double-void is structurally prevented, not just discouraged by convention.

Tradeoffs / deferred:

- No DRAFT/approval workflow — an Expense posts immediately (matches `Adjustment`'s precedent; unlike `ChargeBatch`/`Payment`, there is no per-unit consequence to preview or third-party assertion to verify first).
- No "unvoid" in this MVP — a mistaken void requires creating a fresh, correct Expense, matching every other Finance correction's one-directional pattern.
- Mobile and Backoffice Web UI are not implemented by this ADR — see FIN-EXP-01's Mobile/Backoffice contract preview for the follow-up slice.
- No vendor/purchase-order/budgeting/AP subsystem — deliberately out of scope; this ADR is a disbursement record, not an accounting subsystem.
