# FIN-EXP-01 — Expense / Disbursement Contract Audit & Design

**Implementation status (FIN-EXP-02, 2026-08-16):** Implemented as designed, with one deliberate deviation from Task 20's `voidExpense()` pseudocode: voiding uses the same `updateMany({ where: { status: 'POSTED' } })` CAS pattern `VotingRepository.closeVote` establishes (count-checked, throws `ConflictError` on a lost race) rather than a plain pre-fetched-then-conditionally-written check — a stronger, already-established platform idiom for exactly this concurrency risk, found during FIN-EXP-02's own Phase 1 re-verification of Finance invariants against current code. See `docs/adr/ADR-126-building-expense-disbursement.md` for the as-built record and the FIN-EXP-02 final report for full verification detail. The `Expense` model's field names also gained `title`/`updatedAt` beyond what a couple of early passages below sketch, to match Task 19's own final proposed schema.

**Mode:** Audit + Design only. No production code, migration, or schema file was modified. No commits were made. Mobile and Backoffice Web were inspected read-only, to understand existing conventions and confirm this design won't collide with anything already shipped there.
**Primary repository:** `backend`.
**Trigger:** the Mobile MVP Gap Audit (MOB-GAP-01) found that Building Managers cannot record a real building expense, and that this is not a missing Flutter screen — the backend has no first-class Expense/Disbursement capability at all. This document verifies that conclusively and designs the smallest correct capability that fits VielHome's actual Finance architecture, evidenced against the real source, not conventional accounting assumptions.

---

## TASK 1 — Current Finance Architecture

VielHome's Finance MVP (`backend/src/modules/finance/`) is a **single-entry, append-only ledger system with a denormalized cash cache**, not a full double-entry general ledger. The pieces:

- **`Fund`** (`prisma/schema.prisma:751-773`) — a building may have multiple funds (CURRENT/RESERVE/EMERGENCY/RENOVATION/INSURANCE/CUSTOM). `Fund.balance` is an `Int`, explicitly documented as "a denormalized cache... always reconstructable by replaying LedgerEntry if they ever drift" (schema comment above the Finance section, `prisma/schema.prisma:720-728`). One fund per building is `isDefault: true`, auto-created, and used when a write omits an explicit fund.
- **`ChargeBatch`**/`ChargeItem`** — a Manager issues a batch (`FinanceRepository.issueChargeBatch:366-`) that fans out into one `ChargeItem` per charged unit (the actual receivable). Issuing writes a `CHARGE` LedgerEntry (recognizing the receivable) that does **not** touch `Fund.balance` — a charge is not cash.
- **`Payment`** + **`PaymentAllocation`** (`prisma/schema.prisma:1012-1029`) — any current member may report a payment (`FinanceService.createPayment`'s own doc comment: deliberately not further role-gated beyond membership). On Accountant/Manager approval, `FinanceRepository`'s allocation loop applies the payment oldest-debt-first across the unit's outstanding `ChargeItem`s (and outstanding positive `Adjustment`s), writes one `PaymentAllocation` row per target, and any overflow becomes spendable `CreditBalance`. A `PAYMENT` LedgerEntry is written and **does** increment `Fund.balance` (real cash received).
- **`Adjustment`** (`prisma/schema.prisma:1116-1155`) — a signed, unit-scoped debt correction. Negative = waiver (applied oldest-debt-first against outstanding `ChargeItem`s, excess simply discarded — never creates credit). Positive = an ad hoc charge not backed by a `ChargeBatch` (e.g. one-off fee), tracked via its own `paidAmount` running total. Writes an `ADJUSTMENT` LedgerEntry — **does not** touch `Fund.balance` (it corrects what a unit *owes*, not what the fund physically *holds* — see the exact reasoning in `affectsFundBalance`'s doc comment, `finance.repository.ts:17-39`).
- **`Refund`**/reverse — `reversePayment`/`createRefund` (`finance.repository.ts:1060-`, `1146-`) unwind a payment's allocations and write `REVERSAL`/`REFUND` LedgerEntries that **do** decrement `Fund.balance` (real cash leaving, back to the payer).
- **Opening balance** — there is no dedicated field on `Unit`; a unit's *effective opening balance* is defined as the running sum of `Adjustment` rows tagged `sourceType: 'OPENING_BALANCE_CORRECTION'` (`FinanceService.correctOpeningBalance`'s doc comment, `finance.service.ts:762-`). A *Fund's* opening balance, by contrast, is a real `OPENING_BALANCE` LedgerEntry written once at fund creation (`FinanceRepository.createFund:104-127`) that **does** increment `Fund.balance`.
- **Late fees** — `applyLateFee` (`finance.service.ts:628-`) creates a system-sourced positive `Adjustment` (`sourceType: 'LATE_FEE'`), protected from duplicate application by a DB-level `@@unique([sourceType, sourceId])` constraint on `Adjustment` (`prisma/schema.prisma:1151`).
- **`LedgerEntry`** (`prisma/schema.prisma:1077-1099`) is explicitly "the financial source of truth"; rows are append-only, never updated/deleted. `entryType` ∈ `{CHARGE, PAYMENT, ADJUSTMENT, REFUND, CREDIT_APPLIED, REVERSAL, OPENING_BALANCE}` (`prisma/schema.prisma:1047-1060`).
- **`CreditBalance`** — a running per-unit overpayment balance, applied automatically against a unit's next issued charge.
- **`getFinancialSummary`** (`finance.repository.ts:1235-1279`) returns `{ funds, totalOutstanding, totalCollected, chargeBatchCount }` — `totalOutstanding` from live `ChargeItem`/positive-`Adjustment` aggregates, `totalCollected` from `APPROVED` payments minus their refunds. Nothing here is cached; it's computed live on every call.
- **Reconciliation** — there is no separate reconciliation job/table. `Fund.balance`'s own doc comment states it is "always reconstructable by replaying LedgerEntry if they ever drift" — i.e., the Ledger is the reconciliation source, by design, not a separate mechanism.

### Source of truth, per concept

| Concept | Source of truth | Stored / calculated |
|---|---|---|
| 1. Unit debt | Live aggregate of outstanding `ChargeItem.amount - paidAmount` + outstanding positive `Adjustment.amount - paidAmount` (`FinanceService.getUnitDebt`) | **Calculated** (never cached) |
| 2. Unit credit | `CreditBalance.balance` | **Stored**, but only ever written/read via the payment-overflow and waiver-clawback code paths — effectively a cache of "unapplied overpayment" |
| 3. Fund balance | `Fund.balance` | **Hybrid**: stored denormalized cache, but explicitly documented as reconstructable by replaying `LedgerEntry` — the Ledger is the real authority, the field is a read-optimization |
| 4. Cash/bank balance | Not modeled separately from Fund — see Task 6 | N/A |
| 5. Building financial balance | Sum of that building's `Fund.balance` rows (as returned by `getFinancialSummary.funds`) | **Hybrid**, same as #3 |
| 6. Charge receivables | Live `ChargeItem`/positive-`Adjustment` aggregate | **Calculated** |
| 7. Payments received | `Payment` rows with `status: 'APPROVED'`, net of `Refund` | **Stored** (immutable rows), aggregated live for reporting |

---

## TASK 2 — Confirm the Expense Gap

Searched the entire backend (`grep -rli` across `src/` and `prisma/schema.prisma`) for every term in the task's list: `expense(s)`, `cost(s)`, `disbursement`, `withdrawal`, `outflow`, `spending`, `purchase`, `bill`, `invoice`, `vendor`, `supplier`, `contractor`, `payable`, `ledger debit` (as a concept), `fund withdrawal`, `cash withdrawal`, `bank withdrawal`.

**Result: zero matches for any of them, anywhere in the backend**, except:
- `FundAccountLinkType` (`BANK | CASH`) — metadata-only, describing *which* real-world account a Fund is linked to for display purposes, not a transactional concept (see Task 6).
- The word "purchase" appears only inside `ChargeUnitScope`-adjacent comments about *Marketplace* listings (a different, explicitly-deferred module) and in generic prose — never as a Finance concept.

**Answer: NO.** VielHome does not currently have a real building Expense/Disbursement domain under any name. `LedgerEntryType` has no entry type for money leaving a Fund for a building operating cost — every existing type is either a receivable (`CHARGE`), real cash coming in (`PAYMENT`, `OPENING_BALANCE`), a debt correction with no cash movement (`ADJUSTMENT`, `CREDIT_APPLIED`), or cash going back to a *payer* specifically (`REFUND`, `REVERSAL` — both scoped to unwinding a `Payment`, not a general disbursement). There is no code path anywhere that decrements `Fund.balance` for a reason other than refunding/reversing a resident's payment.

This confirms the prior audit's conclusion exactly, now with full-repository evidence rather than a spot-check.

---

## TASK 3 — MVP Business Capability

Given the architecture above, the fields that are actually load-bearing (vs. the prompt's illustrative list):

| Field | Needed? | Why |
|---|---|---|
| `buildingId` | Required | Every Finance write is building-scoped (`getBuilding` check pattern used everywhere) |
| `fundId` | Required, but resolved not required-from-client | Follow `resolveFundForWrite` exactly (`finance.service.ts:81-92`): accept an optional `fundId` in the DTO, default to the building's default fund via `getOrCreateDefaultFund`, assert `fund.isActive`. This is the one integration point every other write path already shares — reusing it, not reinventing it. |
| `amount` | Required, `Int`, positive | Matches `Fund.balance`/every money field in the schema — Iranian Rial, integer, no floats (ADR-125). |
| `category` | Required | See Task 4. |
| `title` | Required, short string | Every comparable record (`Adjustment.reason`, `Case.title`) has a short mandatory human label; Expense needs one too since "Repair" as a bare category is not enough for a resident reading the Ledger. |
| `description`/`notes` | Optional | Mirrors `Fund.description` (optional) and `Adjustment.reason` (required but free text) — a longer optional note alongside the required `title` gives Managers room without forcing verbosity. |
| `occurredAt` (expense date) | Optional, defaults to `now()` | No existing Finance write lets the caller backdate an event (`Payment`, `Adjustment`, `ChargeBatch` all use `createdAt: @default(now())` as the authoritative timestamp) — but a real building expense (e.g. last week's electricity bill, entered a few days late) legitimately has an occurrence date distinct from entry date. This is a genuine, narrow deviation from precedent, justified because it's the first Finance record type describing an external real-world event rather than an in-app action. Keep `createdAt` as the immutable system timestamp; add `occurredAt` alongside it, not instead of it.
| `payment source/account` | **Not needed for MVP** | See Task 6 — no authoritative account concept beyond `Fund` exists; don't invent one. |
| `receipt/document attachment` | Optional, via existing Documents integration | See Task 13 — don't build new attachment infrastructure. |
| `createdById` | Required | Every write records its actor (`createdById` on `Adjustment`, `actorId` on `LedgerEntry`) — same pattern. |
| `status`/lifecycle | Required, minimal | See Task 12 — `POSTED`/`VOIDED`, not a full workflow. |
| `voidedAt`/`voidedById`/`voidReason` | Required if status includes VOIDED | Mirrors `ChargeBatch.cancelledAt` and the Reverse/Refund `reason` fields exactly. |
| `timestamps` (`createdAt`/`updatedAt`) | Required | Standard on every model in the schema. |
| `idempotencyKey` | Recommended | See Task 16 — reuses the exact `EnforcementAction.idempotencyKey` precedent, not `requestId` (which is not uniqueness-enforced anywhere in Finance). |

---

## TASK 4 — Expense Categories

**Recommendation: A — fixed enum**, matching every other classification concept in this schema (`FundType`, `LateFeeType`, `ChargeUnitScope`, `CaseType` are all fixed Prisma enums, never building-defined free text or a separate lookup table). VielHome's Finance domain has zero precedent for building-configurable taxonomies — introducing one here would be new machinery solely for Expense, contradicting the audit's own "smallest correct capability" mandate.

Proposed `ExpenseCategory` enum (derived from the task's own example list, trimmed to what a VielHome building realistically needs at MVP, matching the level of granularity `FundType`/`CaseType` use — around 6-10 values, not dozens):

```
enum ExpenseCategory {
  UTILITIES        // electricity, water, gas — grouped, not split three ways, matching MVP granularity elsewhere
  CLEANING
  MAINTENANCE
  REPAIR
  ELEVATOR
  SECURITY
  INSURANCE
  ADMINISTRATION
  OTHER
}
```

Why this survives past MVP without a migration crisis: adding a new enum value later is a trivial, additive Prisma migration (VielHome already does this routinely — e.g. `ChargeUnitScope`/`FundType` have grown by addition, never by conversion to a different strategy). The risk the task asks to avoid — "smallest architecture that will not cause obvious migration problems immediately after MVP" — would actually come from choosing B (building-defined categories) now and discovering MVP needed a fixed taxonomy for reporting (Task 14's "expense by category" needs stable, queryable buckets, which a free-form per-building list undermines). Fixed enum is the lower-risk choice in both directions.

---

## TASK 5 — Fund Integration

Walking the exact scenario: Current Fund = 20,000,000 Rial; Manager records Elevator Repair = 5,000,000 Rial from Current Fund.

**Yes — the Fund must become 15,000,000 Rial**, and the mechanism to do it already exists verbatim in this codebase; Expense just needs to be added to the whitelist that already governs it.

- `Fund.balance` is the *only* place a balance is stored (Task 1's answer #3) — an Expense that didn't decrement it would make the Fund's own displayed balance silently wrong the moment real spending starts, which is precisely the gap the Mobile audit flagged as a transparency problem.
- The mechanism is `affectsFundBalance(entryType)` (`finance.repository.ts:17-39`): a small, explicit whitelist function documenting exactly which `LedgerEntryType`s represent real cash movement. Today: `PAYMENT`, `REFUND`, `REVERSAL` (all decrement/increment for cash genuinely entering/leaving via a resident's payment) plus `OPENING_BALANCE`'s own direct increment at fund creation (not routed through the helper function itself, but same conceptual gate — see Task 1 note).
- **Expense is exactly the missing fourth case**: real cash leaving the Fund, but for a reason that has nothing to do with a resident `Payment`. The correct fix is additive: add `EXPENSE` to `LedgerEntryType`, add it to `affectsFundBalance`'s `true` branch (one line + one comment, following the function's own documented style), and in the same `$transaction` that creates the `Expense` row, write an `EXPENSE` LedgerEntry (`direction: 'DEBIT'`) and `tx.fund.update({ data: { balance: { decrement: amount } } })` — the identical shape `reversePayment` already uses (`finance.repository.ts:1113-1122`).
- **Does Expense create a Ledger entry?** Yes — mandatory, in the same transaction, non-optional. Every cash-affecting write in this codebase does this; Expense must too, or `Fund.balance`'s own "reconstructable by replaying LedgerEntry" invariant (Task 1) breaks the first time anyone tries to reconcile.
- **Does Fund itself store balance?** Yes, as the existing denormalized cache — Expense does not change that architecture, it just becomes a fourth contributor to it.
- **Would introducing Expense break any current invariant?** No, provided it's implemented as a new whitelisted entry type exactly like the others. The one thing to guard explicitly: `Fund.balance` must never go negative from an Expense (unlike a resident waiver, which is allowed to leave residual unmet debt) — a fund physically cannot spend cash it doesn't hold. Add an explicit check (`fund.balance >= amount`, thrown as `BusinessRuleViolationError` otherwise) before the decrement — no existing write path needs this check today because none of them can decrement past what came in, but Expense, driven by manual human entry, can.

---

## TASK 6 — Account / Cash / Bank Integration

**Confirmed: NO authoritative account/cash/bank/wallet/treasury concept exists beyond `Fund` itself.**

`FundAccountLinkType` (`BANK | CASH`, `prisma/schema.prisma:744-748`) is explicitly documented as "metadata only, no real bank-integration gateway exists at MVP" — it's a display label (`Fund.accountLinkType`/`accountReference`) attached to a Fund, not a separate ledger-bearing entity. There is no `Account`, `BankAccount`, `CashRegister`, or `Wallet` model anywhere in the schema, and no service that tracks a balance independent of `Fund.balance`.

**Design decision: do not invent one.** Money leaves exactly one place today — a `Fund` — and Expense should decrement exactly that, nothing more. If a building later genuinely needs "this Fund is split across two real bank accounts" tracking, that's a distinct, larger post-MVP feature (multiple `FundAccountLinkType` rows per Fund, essentially a new domain) — not something Expense should pull in as a side effect. This directly matches the task's own fallback instruction: "Do NOT invent a large banking/accounting subsystem for MVP... explain the smallest safe design." The smallest safe design is: Expense debits a `Fund`, full stop — the same scope every other write in this module already has.

---

## TASK 7 — Ledger Effect

**New entry type: `EXPENSE`** (not `DISBURSEMENT`, not reusing `ADJUSTMENT`/`FUND_DEBIT`). Reasoning:

- `LedgerEntry.entryType` is a closed enum whose existing members each represent one specific *business meaning*, not a generic "debit vs credit" mechanism — `direction` (`DEBIT`/`CREDIT`) already carries the arithmetic sign; `entryType` carries *why*. `EXPENSE` reads unambiguously as "the building spent money on something," matching the naming register of `CHARGE`/`PAYMENT`/`ADJUSTMENT`/`REFUND`/`REVERSAL`/`OPENING_BALANCE` (all plain past/present business nouns, not generic accounting jargon like "FUND_DEBIT" — that generic framing is exactly what `direction` already exists to express, so a `FUND_DEBIT` entry type would be redundant with it).
- **`LedgerEntry` should be extended** (new enum value), not bypassed. `LedgerEntry` is the system's one and only source of financial truth (Task 1) — anything that moves real cash *must* be representable there or it isn't real by this system's own definition.
- **Expense is the business record; LedgerEntry is its financial consequence** — exactly the same relationship `Adjustment`/`Payment`/`ChargeBatch` already each have to their own LedgerEntry rows (`referenceType`/`referenceId` pointing back from the Ledger row to the business row that caused it). Preserve this: `LedgerEntry.referenceType = 'Expense'`, `referenceId = expense.id`.
- **Do not overload `PAYMENT` or `CHARGE`.** `PAYMENT` means "cash a resident sent in" (its DTO, controller doc comments, and event names — `PaymentApprovedEvent` etc. — are unambiguous about payer-side semantics); `CHARGE` means "a receivable a unit owes." Neither has any conceptual or structural room for "the building spent money externally" without corrupting reports that already assume those meanings (`getFinancialSummary`'s `totalCollected`, `getCollectionRate` — both would become wrong if an outgoing expense were disguised as a negative payment).

**Invariant to define and enforce:** *every* `Expense` row with status `POSTED` has exactly one corresponding `EXPENSE` LedgerEntry (`referenceType: 'Expense', referenceId: expense.id`), created in the same transaction, and *every* void of a `POSTED` Expense has exactly one corresponding reversing LedgerEntry (see Task 12) — mirroring `Payment.status`/`REVERSAL`'s own 1:1 relationship. No `Expense` should ever exist without its Ledger counterpart or vice versa.

---

## TASK 8 — Unit Debt / Charge Separation

**Confirmed: this conceptual separation already exists exactly as described, and Expense must preserve it.**

Evidence: `ChargeBatch`/`ChargeItem` ("what units owe") and `Payment` ("what was received from a payer") are structurally unconnected to `Fund` spending anywhere in the current code — `issueChargeBatch` never reads `Fund.balance`, and nothing in `createPayment`/`approvePayment` ever creates or requires an `Expense`. The two flows (money coming in as charges/payments vs. money going out) share only `Fund` and `LedgerEntry` as common ground today, and that's exactly right.

So: **recording a 5,000,000 Rial elevator repair Expense must never automatically create a Charge, ChargeItem, or any per-unit debt.** It only ever affects the `Fund` (Task 5) and the Ledger. Distributing that cost among units is, and must remain, a distinct, manually-triggered action (the existing `createChargeBatch`, unchanged) — exactly the separation the task describes:

- **Expense** = "money the building spent" → touches `Fund`, `LedgerEntry`. Never touches `ChargeItem`/unit debt.
- **Charge** = "money units owe" → touches `ChargeItem`/unit debt. Never directly touches `Fund.balance` (Task 1 — `CHARGE` doesn't affect fund balance either, it's a receivable, not cash; confirmed consistent).
- **Payment** = "money received from a payer" → the only thing that actually adds cash to `Fund.balance` today, alongside the new `Expense` (removing it) and `OPENING_BALANCE` (seeding it).

This is not a new design decision so much as recognition that VielHome's architecture already enforces this separation everywhere else, and Expense's job is to not be the first thing that breaks it.

---

## TASK 9 — Expense → Charge Relationship

**Recommendation: remain completely independent for MVP — no coupling in either direction.**

Reasoning: a Manager creating a Charge Batch to recoup an elevator repair is, operationally, a *decision* made sometime after the expense (how much to charge, which units, whether to spread it over multiple months) — not a deterministic derivation from the Expense row. Forcing a reference now would mean guessing at a UX/workflow (`generateChargeFromExpense`?) the task explicitly says to avoid designing ("Avoid unnecessary coupling"), and no existing Finance flow has this kind of "record A, later linked B" cross-reference pattern to extend cleanly (the closest analogue, `Adjustment.sourceType/sourceId`, points *backward* from a system-generated correction to what caused it — e.g. a late fee to its ChargeItem — not forward from a spend to a future charge; the direction and intent are different).

If a future phase wants this traceability, the safe, additive shape to add later (not now) is a **nullable, optional `Expense.linkedChargeBatchId`** set manually by the Manager when creating a Charge Batch that happens to be recouping a known Expense — purely informational, never required, never enforced, never driving any calculation. Do not build this in FIN-EXP-02; note it here so it isn't reinvented awkwardly later.

---

## TASK 10 — Authorization

Directly matches the existing Finance authorization pattern with zero new roles or permission concepts:

| Action | Roles | Guard | Precedent |
|---|---|---|---|
| CREATE | `MANAGER`, `ACCOUNTANT` | `RolesGuard` + `@Roles('MANAGER','ACCOUNTANT')` | Identical pairing to `createAdjustment`/`applyLateFee`/`correctOpeningBalance` (`finance.controller.ts:270,300,320`) — "both are financial corrections with the same real-money consequence," and Expense is the same category of operation. |
| VIEW (list/detail) | Any current member (Owner, Tenant, Board, Manager, Accountant) | `MembershipGuard` | Identical to every other Finance read (`GET :id/funds`, `GET :id/financial-summary`, `GET :id/ledger` — all `MembershipGuard`, no role restriction). Financial transparency to residents is already the norm for every existing Finance read endpoint; Expense should not be the first exception. |
| EDIT | **Nobody** — no edit endpoint at all | — | See Task 11 — immutability, not editability. |
| CANCEL/VOID | `MANAGER`, `ACCOUNTANT` | Same as CREATE | Same actors who can create should be the only ones who can correct their own mistake; matches `cancelChargeBatch`'s `@Roles('MANAGER')`-only pattern in spirit (Manager can undo their own draft actions). |
| DELETE | **Nobody** — no delete endpoint at all | — | Nothing in Finance has a hard-delete endpoint (`Fund` uses deactivate/reactivate, `ChargeBatch` uses cancel, `Payment` uses reverse/refund) — Finance rows are never destroyed, only voided/reversed. Expense must follow the same rule or it becomes the one place in Finance where history can vanish. |

`RolesGuard`'s own doc comment (`roles.guard.ts:20-22`) already resolves "Manager: expected to manage... Accountant: expected to manage when an Accountant exists" for free: roles held on a building are unioned (OR-based), so a building with only a Manager (no Accountant) simply has one role satisfying the gate instead of two — no special-casing needed.

---

## TASK 11 — Immutability / Correction Policy

**Recommendation: C — immutable after creation; corrections use VOID, matching the rest of Finance exactly.**

Every financial record in this system already follows this rule: `LedgerEntry` is explicitly append-only ("application code must never UPDATE or DELETE a LedgerEntry row"). `Payment` is never edited post-creation, only reversed/refunded. `ChargeBatch` is never edited, only cancelled (while still DRAFT). `Adjustment` rows are never edited, only offset by a new corrective `Adjustment`. Option A (freely editable) or B (editable until some state) would make Expense the *only* financial record in the entire system that can be silently rewritten — directly contradicting `03_Core_Principles > Principle 6` (referenced by `AuditService`'s own doc comment: "immutable... Who/When/What/Why").

**Worked correction example (5m recorded, 4.5m actual):** the Manager voids the incorrect 5m Expense (with a mandatory `voidReason`, e.g. "entered wrong amount, see corrected entry") and creates a new, correct 4.5m Expense. Both rows remain visible forever — the Ledger shows a `+5,000,000` DEBIT immediately followed by a `-5,000,000` CREDIT reversal (net zero) and then a fresh `+4,500,000` DEBIT. This is the exact same pattern `reversePayment` already uses for a wrongly-approved payment — nothing new to invent, and it gives a future auditor (or Board Member reading the Ledger) the complete, honest history rather than a mutated row that looks like it was always 4.5m.

---

## TASK 12 — Status Lifecycle

**Recommendation: `POSTED` / `VOIDED` — two states, no `DRAFT`, no approval workflow.**

The task's own instruction to avoid over-engineering matches the architecture precedent closely: `Payment` has a real approval workflow (`PENDING_APPROVAL → APPROVED/REJECTED`) because a *third party* (the payer) is asserting something the building must verify before trusting it — that's the reason approval exists there. Expense has no such asymmetry: the Manager/Accountant creating it is the same authority who'd "approve" it, so a `PENDING_APPROVAL` state would just be needless friction with no distinct actor to relieve it. `ChargeBatch` is the closer analogue and it *does* have a `DRAFT` state — but that exists specifically because issuing a charge batch is consequential and hard to undo (it creates real per-unit debt Owners immediately see) and previewing first is valuable (`previewChargeBatch`). An Expense has no preview step in this design and no per-unit consequence to get right before committing — it's a single atomic record of something that already happened (an occurred, real-world spend), closer in spirit to `Adjustment` (no draft state, `finance.repository.ts:729-`) than to `ChargeBatch`.

```
enum ExpenseStatus {
  POSTED
  VOIDED
}
```

---

## TASK 13 — Attachments / Receipts

**Recommendation: B — optional, not required, for MVP.** Requiring a receipt for every expense would block a Manager from recording a legitimate cash expense with no digital receipt (common for small building-level purchases), directly working against the goal of closing MOB-GAP-01 quickly. Post-MVP could tighten this per-category if the business wants it (e.g. require above some amount threshold) — don't decide that now.

**Integration is clean and additive, reusing Documents exactly as-is — no new attachment mechanism needed.** `DocumentReferenceEntityType` (`prisma/schema.prisma:1770-1787`) is already a polymorphic `(entityType, entityId)` pattern used for `CHARGE_BATCH`, `PAYMENT`, `CASE`, `VOTE`, `MEETING`, etc. — each entity type was added by simple, additive enum extension, and the enum's own doc comment explicitly notes `entityId` existence is deliberately never cross-checked against the target domain, "keeps DocumentsModule from needing to import [other] Module" — i.e. this pattern was *designed* to be extended by every domain without coupling. Add `EXPENSE` to this enum; a Manager attaches a receipt the same way they already attach a document to a Case or Payment today, via the existing `POST :documentId/references` endpoint, no Expense-specific upload code required.

---

## TASK 14 — Reporting Effect

**`getFinancialSummary` (`finance.repository.ts:1235-1279`) becomes actively misleading once Expenses exist, unless extended.** Today it returns `{ funds, totalOutstanding, totalCollected, chargeBatchCount }`. `funds[].balance` will correctly reflect expense decrements automatically (Task 5), but `totalCollected` will keep reporting gross income with no visibility into what was spent — a Board Member reading this summary would see "total collected: 50,000,000" with no way to tell whether 45,000,000 of that has already been spent on legitimate building costs. This is exactly the transparency gap the Mobile audit flagged, and it would persist even after Expense ships if this report isn't touched.

**Minimum required change:** add `totalExpenses` (a live aggregate of `POSTED` `Expense.amount`, same computation style as the existing `totalOutstanding`/`totalCollected` aggregates — no new caching). This alone answers "net cash flow" implicitly (`totalCollected - totalExpenses`) without needing a separately-maintained field.

**Recommend for MVP, small additions only:**
- `totalExpenses` on `getFinancialSummary` (as above).
- Expense list already supports "expense by period" via the existing pagination + a `fromDate`/`toDate` filter (same shape `getCollectionRate` already takes) — no new report needed, just filter params on the list endpoint.

**Explicitly NOT required for MVP** (would be new report surfaces, not extensions of existing ones): "expense by category" as a dedicated breakdown endpoint (a Manager can filter the list by category and sum manually, or this can be trivially added post-MVP once real usage shows it's wanted), a dedicated "net cash flow" report object (derivable from the two totals above), any chart/visualization surface (none exist in Finance today; not this phase's job).

**`listLedger`** (`GET :id/ledger`) needs **no changes** — it's already a generic `LedgerEntry` list; a new `EXPENSE` entry type appears in it automatically, the same way `REVERSAL` did when ADR-037 added it.

---

## TASK 15 — Audit Log

Following `AuditService.record`'s established convention exactly (`action` string matches domain event names, PascalCase, past tense — `'FundCreated'`, `'AdjustmentCreated'`, `'UnitOpeningBalanceCorrected'`):

| Event | `action` | `entityType` | `metadata` |
|---|---|---|---|
| Expense created | `ExpenseCreated` | `Expense` | `{ fundId, amount, category }` |
| Expense voided | `ExpenseVoided` | `Expense` | `{ amount, voidReason }` |

Both recorded via `this.audit.record({...})` inside `FinanceService`, same call shape as every other Finance action, immediately after the repository transaction commits (never inside it — `AuditService` is a separate write, matching every existing call site).

---

## TASK 16 — Idempotency / Duplicate Submission

**Existing Finance-wide pattern is weaker than it looks:** `requestId` is threaded through nearly every Finance service method and stored on both `LedgerEntry` and `AuditLog` (`prisma/schema.prisma:1091,3514`), but it is a **plain nullable `String?` with no unique constraint anywhere** — it's a tracing/correlation field for logs, not a duplicate-submission guard. A genuine mobile double-tap or network retry with the same `requestId` today would create two full `Adjustment`/`Payment`/`Fund` rows with two Ledger entries — nothing in the current Finance write path actually prevents this.

There *is* a real, DB-level idempotency precedent elsewhere in this codebase worth reusing instead: **`EnforcementAction.idempotencyKey String? @unique`** (Fraud module, `prisma/schema.prisma:3156`) — a client-supplied key, enforced unique at the database level, so a retried request with the same key hits a real constraint violation rather than silently duplicating. This is exactly the shape a financial mutation initiated from a mobile client (where retries are a real, common failure mode per the task's own framing) needs.

**Recommendation:** add `idempotencyKey String? @unique` to `Expense` (nullable so server-to-server/Backoffice-triggered creation, if it ever exists, isn't forced to fabricate one — mirroring `EnforcementAction`'s own optionality). Mobile generates a UUID once per user-initiated submission attempt and resends the *same* key on any automatic retry. On a unique-constraint hit, the service catches `Prisma.PrismaClientKnownRequestError` with `code: 'P2002'` (the exact pattern `isUniqueConstraintViolation` already implements for the adjustment `sourceType/sourceId` race, `finance.service.ts:29-32`) and returns the original Expense instead of erroring — true idempotent-retry semantics, not just error suppression.

---

## TASK 17 — Concurrency

- **Two expenses submitted concurrently** (different requests, not a retry of the same one): both are legitimate distinct rows — no conflict, no special handling needed. Prisma's default transaction isolation on the `Fund.balance` decrement (`{ decrement: amount }`, an atomic SQL-level operation, not a read-then-write) already makes two concurrent decrements safe and correct — this is the exact mechanism every existing cash-affecting write (`PAYMENT`, `REVERSAL`, `OPENING_BALANCE`) already relies on; Expense needs nothing extra here.
- **Expense vs. Fund reconciliation:** not a live concern for MVP — there is no separate reconciliation *process* running concurrently against `Fund.balance` today (Task 1); the only "reconciliation" is the documented ability to replay `LedgerEntry` if it's ever needed, which is an offline/manual operation, not a concurrent writer.
- **Voiding an expense twice:** guard the same way `updateFund`'s deactivate/reactivate pair and `cancelChargeBatch` implicitly do — check `expense.status === 'POSTED'` before voiding, inside the same transaction that performs the void, throwing `BusinessRuleViolationError` if it's already `VOIDED`. A DB-level guard isn't necessary here (an application-level check inside a transaction is the established pattern for every other status-transition guard in this module — none of `Payment.status`/`ChargeBatch.status`/`Fund.isActive`'s transitions use anything stronger).
- **Simultaneous financial operations generally:** every write already goes through `prisma.$transaction`, which is sufficient isolation for this MVP's realistic concurrency risk (a handful of staff per building, not high-frequency trading). **Do not add CAS/optimistic-locking version fields** — nothing else in Finance has them, and introducing one just for Expense would be inconsistent, unrequested complexity for a risk level this module doesn't otherwise treat as needing it.

---

## TASK 18 — Proposed API Contract

Routing convention check: **every existing Finance write is a flat resource directly under `buildings/:id/...`** — `funds`, `charges`, `payments` — never nested under a `/finance/` segment (there is no `finance` path literal anywhere in `finance.controller.ts`'s routes). The task's own illustrative example (`/buildings/:buildingId/finance/expenses`) does not match this. Using the repository's actual convention:

```
POST   /v1/buildings/:id/expenses
GET    /v1/buildings/:id/expenses
GET    /v1/buildings/:id/expenses/:expenseId
POST   /v1/buildings/:id/expenses/:expenseId/void
```

(`FinanceController` already shares its `buildings` base path with `BuildingController`/`VotingController` safely — same "Nest resolves by full path, no collision" precedent noted in its own class doc comment; `expenses` doesn't collide with any existing literal segment.)

### `CreateExpenseDto` (POST body)
```ts
class CreateExpenseDto {
  @IsString() @IsNotEmpty() title: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum(ExpenseCategory) category: ExpenseCategory;
  @IsInt() @IsPositive() amount: number;
  @IsOptional() @IsString() fundId?: string;          // defaults via resolveFundForWrite, matches createAdjustment/createPayment
  @IsOptional() @IsDateString() occurredAt?: string;    // defaults to now()
  @IsOptional() @IsUUID() idempotencyKey?: string;
}
```

### `VoidExpenseDto`
```ts
class VoidExpenseDto {
  @IsString() @IsNotEmpty() voidReason: string;   // same required-reason shape as AdminReversePaymentDto
}
```

### Response shape (matches `withEnvelope`'s existing convention)
```
Expense {
  id, buildingId, fundId, title, description, category, amount,
  occurredAt, status, createdById, createdAt,
  voidedAt, voidedById, voidReason, updatedAt
}
```
List responses use the established `withEnvelope(items, { metadata: { pagination: meta } })` shape every other paginated Finance list already returns (`listFunds`, `listPayments`, `listUnitAdjustments`).

### Pagination & filters
`page`/`limit` via `parsePagination` (ADR-072 convention, identical to every other list route). Filters on `GET :id/expenses`: `fundId?`, `category?`, `status?` (defaults to excluding VOIDED unless explicitly requested, matching how `listPayments` accepts an optional `?status=`), `fromDate?`/`toDate?` (matching `getCollectionRate`'s date-range param shape) for the "expense by period" need from Task 14.

### Authorization
Per Task 10: `POST .../expenses` and `POST .../expenses/:id/void` → `@UseGuards(RolesGuard) @Roles('MANAGER','ACCOUNTANT')`. Both `GET` routes → `@UseGuards(MembershipGuard)`.

### Errors / status codes (reusing the existing Finance error vocabulary — no new error types)
| Condition | Error class | HTTP |
|---|---|---|
| Building/Fund/Expense not found | `NotFoundAppError` | 404 |
| Caller lacks Manager/Accountant role | `AuthorizationError` (via guard) | 403 |
| Invalid body (missing title, non-positive amount, unknown category) | class-validator → `ValidationError` | 400 |
| Fund inactive | `FundPolicy.assertActive` → `BusinessRuleViolationError` | 422 |
| Amount exceeds Fund's current balance | new `ExpensePolicy.assertSufficientFundBalance` → `BusinessRuleViolationError` | 422 |
| Already-voided expense voided again | `BusinessRuleViolationError` | 422 |
| Duplicate `idempotencyKey` (genuine retry) | caught `P2002` → return original `Expense`, not an error | 200/201 |

---

## TASK 19 — Proposed Data Model

```prisma
enum ExpenseCategory {
  UTILITIES
  CLEANING
  MAINTENANCE
  REPAIR
  ELEVATOR
  SECURITY
  INSURANCE
  ADMINISTRATION
  OTHER
}

enum ExpenseStatus {
  POSTED
  VOIDED
}

// FIN-EXP-02 — the building-operating-cost counterpart to Payment/Adjustment
// above: "money the building spent," deliberately kept separate from Charge
// ("money units owe") and Payment ("money received from a payer") — see
// FIN-EXP-01 design doc Task 8. Immutable after creation; corrections are a
// VOID of the wrong row plus a fresh correct one (Task 11), never an edit —
// same convention as every other Finance record in this file.
model Expense {
  id             String          @id @default(cuid())
  buildingId     String
  building       Building        @relation(fields: [buildingId], references: [id])
  fundId         String
  fund           Fund            @relation(fields: [fundId], references: [id])
  title          String
  description    String?
  category       ExpenseCategory
  // Iranian Rial, integer, no floats — same convention as every other
  // amount field in this schema (ADR-125).
  amount         Int
  // When the cost actually occurred in the real world (e.g. the utility
  // bill's date), distinct from `createdAt` (when it was entered into
  // VielHome) — see FIN-EXP-01 Task 3 for why this is the one new field
  // not mirrored from an existing Finance record.
  occurredAt     DateTime        @default(now())
  status         ExpenseStatus   @default(POSTED)
  createdById    String
  createdBy      Person          @relation("ExpenseCreatedBy", fields: [createdById], references: [id])
  voidedAt       DateTime?
  voidedById     String?
  voidedBy       Person?         @relation("ExpenseVoidedBy", fields: [voidedById], references: [id])
  voidReason     String?
  // Task 16 — client-supplied, DB-enforced duplicate-submission guard,
  // same shape as EnforcementAction.idempotencyKey. Nullable: not every
  // future caller (e.g. a system-triggered path, if one is ever added)
  // is required to supply one.
  idempotencyKey String?         @unique
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  @@index([buildingId])
  @@index([fundId])
  @@index([buildingId, status])
  @@index([buildingId, category])
  @@map("expenses")
}
```

Also required, additive-only changes to existing enums/models (no existing field/relation touched):
- `LedgerEntryType` — add `EXPENSE`.
- `affectsFundBalance()` (`finance.repository.ts`) — add `entryType === 'EXPENSE'` to the `true` branch, with a comment following its existing documentation style ("EXPENSE is real cash leaving the fund for a building operating cost — it DOES update the cache, as a decrement, the mirror image of PAYMENT").
- `DocumentReferenceEntityType` — add `EXPENSE` (Task 13).
- `Building`/`Fund`/`Person` — add the reverse relation fields (`expenses Expense[]` etc.) Prisma requires for the new relations above; no other change to those models.

**Constraints:** `amount` has no DB-level `CHECK > 0` (Prisma/Postgres here don't use raw CHECK constraints elsewhere for this — `@IsPositive()` at the DTO layer is the established enforcement point, matching `CreateFundDto.initialBalance`/`CreateAdjustmentDto.amount`). `idempotencyKey` is the only new true uniqueness constraint. `@@index([buildingId, status])` and `@@index([buildingId, category])` support the list endpoint's default (exclude voided) and category filters without a full scan, matching the indexing density `Adjustment`/`ChargeBatch` already have.

---

## TASK 20 — Ledger Transaction Design

### `createExpense()`

```
FinanceService.createExpense(buildingId, dto, actorPersonId, requestId):
  building = getBuilding(buildingId)                        // 404 if missing
  // RolesGuard already enforced MANAGER|ACCOUNTANT before this method runs —
  // no in-method membership/role re-check needed, same as createAdjustment.
  ExpensePolicy.assertValidAmount(dto.amount)                // > 0, same style as assertValidAdjustmentAmount
  fund = resolveFundForWrite(buildingId, dto.fundId)          // existing helper — 404 or 422 (inactive)

  expense = finance.createExpense({                          // <-- single $transaction, repository layer
    buildingId, fundId: fund.id, title: dto.title,
    description: dto.description, category: dto.category,
    amount: dto.amount, occurredAt: dto.occurredAt ?? now(),
    createdById: actorPersonId, idempotencyKey: dto.idempotencyKey,
    requestId,
  })
  // inside FinanceRepository.createExpense's $transaction:
  //   1. re-fetch fund FOR UPDATE semantics via the same transaction client (tx.fund)
  //      to read current balance inside the transaction, not the pre-fetched copy
  //   2. if fund.balance < amount: throw BusinessRuleViolationError (never partially applied)
  //   3. tx.expense.create({ ...POSTED... })
  //   4. tx.ledgerEntry.create({ entryType: 'EXPENSE', direction: 'DEBIT', amount,
  //                              referenceType: 'Expense', referenceId: expense.id,
  //                              actorId, requestId })
  //   5. tx.fund.update({ where: { id: fund.id }, data: { balance: { decrement: amount } } })
  //   6. return expense
  // idempotency: if params.idempotencyKey is set and a P2002 unique violation
  // is thrown on step 3, catch it OUTSIDE the transaction (transaction already
  // rolled back atomically), re-fetch the existing Expense by idempotencyKey,
  // and return it instead of raising — exact same isUniqueConstraintViolation
  // pattern already used for Adjustment's sourceType/sourceId race.

  audit.record({ action: 'ExpenseCreated', entityType: 'Expense', entityId: expense.id,
                  actorId: actorPersonId, buildingId, requestId,
                  metadata: { fundId: fund.id, amount: dto.amount, category: dto.category } })

  events.emit('ExpenseCreated', new ExpenseCreatedEvent(expense.id, buildingId, fund.id, dto.amount, actorPersonId))
  // Notification wiring is OPTIONAL for MVP — see Task 14/Output 7. Emitting
  // the event costs nothing (matches the "emit now, wire later" precedent
  // ADR-042 already established for AdjustmentCreatedEvent/PaymentReversedEvent
  // — all three sat unwired for a full sprint before NotificationEventListener
  // picked them up); a listener can be added later with zero Expense-side change.

  return expense
```

### `voidExpense()`

```
FinanceService.voidExpense(buildingId, expenseId, dto, actorPersonId, requestId):
  expense = finance.findExpenseById(expenseId)
  if !expense || expense.buildingId !== buildingId: throw NotFoundAppError

  voided = finance.voidExpense({ expenseId, buildingId, fundId: expense.fundId,
                                  amount: expense.amount, voidReason: dto.voidReason,
                                  actorId: actorPersonId, requestId })
  // inside FinanceRepository.voidExpense's $transaction:
  //   1. tx.expense.findUnique — re-check status === 'POSTED' INSIDE the
  //      transaction (not the pre-fetched copy) — throws BusinessRuleViolationError
  //      if already VOIDED, preventing the double-void race (Task 17)
  //   2. tx.expense.update({ status: 'VOIDED', voidedAt: now(), voidedById: actorId, voidReason })
  //   3. tx.ledgerEntry.create({ entryType: 'EXPENSE', direction: 'CREDIT', amount,
  //                              referenceType: 'Expense', referenceId: expenseId,
  //                              description: 'Expense voided', actorId, requestId })
  //      // a CREDIT counter-entry, not a delete/edit of the original DEBIT —
  //      // same "reversal creates counter entry" invariant ADR-037 established
  //      // for Payment REVERSAL, applied here to Expense.
  //   4. tx.fund.update({ where: { id: fundId }, data: { balance: { increment: amount } } })
  //   5. return updated expense

  audit.record({ action: 'ExpenseVoided', entityType: 'Expense', entityId: expenseId,
                  actorId: actorPersonId, buildingId, requestId, reason: dto.voidReason,
                  metadata: { amount: expense.amount } })

  return voided
```

**How partial writes are prevented:** identical mechanism to every existing Finance write — the Expense row, its LedgerEntry, and the Fund balance update all happen inside one `prisma.$transaction(async (tx) => {...})` callback. If any step throws (including the new "amount exceeds fund balance" or "already voided" checks), Prisma rolls back the entire transaction — there is never a state where an Expense row exists without its Ledger entry, or where the Fund balance moved without a corresponding Ledger row. This is not a new mechanism to build; it's the same `$transaction` wrapper `createAdjustment`/`applyOpeningBalanceCorrection`/`reversePayment` already use, applied to the new write.

---

## TASK 21 — Mobile Contract Preview (short, not final UI/UX)

For Manager/Accountant, once FIN-EXP-02 ships:

- **`expense_api.dart`**: `createExpense(buildingId, {title, description, category, amount, fundId?, occurredAt?, idempotencyKey})`, `listExpenses(buildingId, {page, limit, fundId?, category?, status?, fromDate?, toDate?})`, `getExpense(buildingId, expenseId)`, `voidExpense(buildingId, expenseId, voidReason)`.
- **Controller/state**: a `RecordExpenseController` following the exact shape of `charge_batch_create_controller.dart`/`opening_balance_correction_controller.dart` (local form state → submit → success/error), and an `ExpenseListScreen`/`ExpenseDetailScreen` pair following `pending_payments_screen.dart`/`payment_detail_screen.dart`'s list/detail split.
- **Entry point**: a new card on `building_detail_screen.dart`, gated `if (isManager || isAccountant)`, next to the existing Funds/Pending Payments cards — same placement pattern already established there.
- **Category picker**: a fixed dropdown over `ExpenseCategory`'s enum values (Task 4) — no dynamic fetch needed, mirroring how `create_fund_screen.dart` hardcodes `_accountLinkTypes = ['BANK','CASH']` from the fixed backend enum today.
- **Void action**: an Accountant/Manager-only destructive action on the detail screen, following `payment-reverse-action`'s confirm-dialog pattern (already proven in Backoffice Web for an analogous "reason-required destructive Finance action").

This is intentionally the full extent of Mobile scoping in this document — no screens, no wireframes, no final field layout. That's MOB-EXP-01's job, after this contract is approved and built.

---

## TASK 22 — Backoffice Boundary

**Confirmed: NO Expense mutation capability needed in Backoffice Web for MVP.** This is building-level operational data belonging to the roles who actually run the building (Manager/Accountant, both resident-side roles reached via Mobile) — not a platform-staff administrative concern. Every comparable building-operational Finance action (Fund management, Charge Batch creation, payment approval) already has zero Backoffice *mutation* surface today; only genuinely administrative/override actions (Payment Reverse/Refund override, Manager Verification admin review) exist in Backoffice, each for a documented compliance/oversight reason distinct from ordinary operation. Expense doesn't fit that pattern — recording an elevator repair isn't a compliance action, it's routine building management. Recommend Backoffice read-only visibility (e.g., surfaced inside the existing `financial-administration` read views, alongside the read-only Payment/Refund history already there) as a natural, low-cost follow-on for staff support/audit purposes — but this is optional polish, not required for FIN-EXP-02, and explicitly out of scope for this document to design further.

---

## TASK 23 — What NOT to Build

- **Full double-entry accounting** — VielHome's Finance MVP is deliberately single-entry-with-a-cache (Task 1); Expense should match that, not introduce double-entry bookkeeping as its first appearance in the codebase.
- **Vendor/supplier management** (a `Vendor`/`Supplier` model, contact records, ratings) — `title`/`description` free text covers "who was paid" adequately for MVP; a structured vendor directory is a distinct, larger feature.
- **Purchase orders / accounts payable / invoice approval chains** — no approval workflow exists for any comparable Finance action (Task 12); don't introduce one for Expense specifically.
- **Recurring vendor contracts / recurring expenses** — no scheduling/recurrence concept exists anywhere in Finance today (charges are batch-generated per period by explicit Manager action, never auto-recurring); out of scope.
- **Tax accounting** — no tax concept anywhere in this schema; not this phase's concern.
- **Marketplace integration** — explicitly Post-MVP per product direction; Expense must have zero dependency on it.
- **OCR receipt processing** — Documents already stores raw uploads; parsing/extracting data from them is unrelated to recording an Expense's own fields.
- **Complex budgeting / forecasting** — no budget concept exists in Finance; `totalExpenses` (Task 14) is a historical actual, not a plan/variance system.
- **Building-defined expense categories** — rejected in Task 4 in favor of a fixed enum.
- **Bank/cash account modeling beyond `Fund`** — rejected in Task 6.
- **Expense ↔ Charge automatic coupling** — rejected in Task 9; keep independent, optionally-linkable at most in a later phase.
- **A `DRAFT` status / preview flow for Expense** — rejected in Task 12; unlike ChargeBatch, there's no per-unit consequence to preview.

---

## OUTPUT 1 — Executive Decision

**Expense capability currently: NO.**

**Recommended MVP architecture:** a new, minimal `Expense` model — building- and fund-scoped, fixed-enum category, `POSTED`/`VOIDED` two-state lifecycle, immutable-with-void correction policy, optional Documents attachment via the existing polymorphic reference pattern, client-supplied unique `idempotencyKey` for duplicate-submission safety — that plugs into the existing Ledger/Fund-balance mechanism through exactly one additive change (`EXPENSE` added to `LedgerEntryType` and to `affectsFundBalance`'s whitelist). No new subsystem, no new accounting model, no coupling to Charge/Payment beyond sharing `Fund` and `LedgerEntry` the way every other Finance write already does.

**Backend work required: YES.** Confirmed conclusively in Task 2 — there is no equivalent capability under any name.

**Mobile can safely start before backend: NO.** There is no contract to build against yet; starting Mobile now would mean guessing at a shape this document exists specifically to prevent guessing at.

---

## OUTPUT 2 — Current Finance Map

| Capability | Source of truth | Models | Ledger effect | Current API | Relevant roles |
|---|---|---|---|---|---|
| Unit debt | Live calculation | `ChargeItem`, `Adjustment` | `CHARGE` (no fund effect), `ADJUSTMENT` (no fund effect) | `GET :id/units/:unitId/debt` | All (read), Manager/Accountant (write via Adjustment) |
| Unit credit | Stored cache | `CreditBalance` | Written as a side effect of `PAYMENT`/`REVERSAL` | Read via `getUnitDebt` | All (read) |
| Fund balance | Hybrid (cached, Ledger-reconstructable) | `Fund` | `PAYMENT`+, `REFUND`−, `REVERSAL`−, `OPENING_BALANCE`+ | `GET/POST :id/funds` | All (read), Manager (write) |
| Charge receivables | Live calculation | `ChargeBatch`, `ChargeItem` | `CHARGE` (no fund effect) | `GET/POST :id/charges` | All (read), Manager (write) |
| Payments received | Stored, aggregated live | `Payment`, `PaymentAllocation`, `Refund` | `PAYMENT`+, `REFUND`−, `REVERSAL`− | `GET/POST :id/payments`, approve/reject/reverse/refund | All (report), Accountant/Manager (approve/reject/reverse/refund) |
| **Expense (proposed)** | **New: stored, immutable** | **New: `Expense`** | **New: `EXPENSE`−, void = `EXPENSE`+ counter-entry** | **New: `GET/POST :id/expenses`, void** | **All (read), Manager/Accountant (write)** |

---

## OUTPUT 3 — Proposed Expense Domain

- **Meaning:** an immutable record of real money the building spent from one of its Funds on a building operating cost, distinct from a resident-owed Charge and from a resident-sent Payment.
- **Invariants:** (1) every `POSTED` Expense has exactly one `EXPENSE` LedgerEntry; (2) a Fund's balance is decremented by exactly the Expense amount in the same transaction as its creation, and never allowed to go negative from an Expense; (3) an Expense is never edited or hard-deleted, only voided; (4) a void produces a counter LedgerEntry restoring the Fund balance, never a mutation of the original entry; (5) `idempotencyKey`, when supplied, uniquely identifies one Expense — a retried request with the same key never creates a second row.
- **Lifecycle:** `POSTED` (on creation) → `VOIDED` (terminal; no further transitions).
- **Authorization:** create/void = Manager or Accountant (building-role union, `RolesGuard`); view = any current member (`MembershipGuard`).
- **Fund relationship:** required `fundId` (defaulted via the existing `resolveFundForWrite`); decrements `Fund.balance` on creation, increments it back on void.
- **Ledger relationship:** the business record; the `EXPENSE` LedgerEntry is its mandatory financial consequence, linked via `referenceType`/`referenceId`.
- **Charge relationship:** none, by design (Task 8/9) — fully independent.
- **Payment relationship:** none — Expense never touches `Payment`, `PaymentAllocation`, or unit debt in any way.

---

## OUTPUT 4 — Data Model

See Task 19 in full above — the proposed `Expense` model, `ExpenseCategory`/`ExpenseStatus` enums, and the four additive changes to existing enums/models (`LedgerEntryType`, `affectsFundBalance`, `DocumentReferenceEntityType`, reverse relations on `Building`/`Fund`/`Person`). No existing field is modified or removed.

---

## OUTPUT 5 — API Contract

See Task 18 in full above — `POST/GET :id/expenses`, `GET :id/expenses/:expenseId`, `POST :id/expenses/:expenseId/void`, with `CreateExpenseDto`/`VoidExpenseDto`, pagination/filter shape, authorization, and the full error/status-code table.

---

## OUTPUT 6 — Transaction / Ledger Flow

See Task 20 in full above — `createExpense()` and `voidExpense()` pseudocode with explicit transaction boundaries, fund-sufficiency and double-void guards, and the idempotency catch path.

---

## OUTPUT 7 — MVP vs. Post-MVP

**MVP (FIN-EXP-02):**
- `Expense` model + `ExpenseCategory`(fixed enum)/`ExpenseStatus` enums
- `EXPENSE` LedgerEntryType + `affectsFundBalance` extension
- Create / List / Detail / Void endpoints, Manager+Accountant write, all-members read
- Fund-sufficiency check on create; double-void guard
- `idempotencyKey` duplicate-submission protection
- Optional Documents attachment via `DocumentReferenceEntityType.EXPENSE`
- `AuditLog` events (`ExpenseCreated`, `ExpenseVoided`)
- `getFinancialSummary` extended with `totalExpenses`
- List filters: `fundId`, `category`, `status`, date range

**POST-MVP:**
- Notification wiring for `ExpenseCreatedEvent` (event emission ships in MVP; a listener does not have to)
- Dedicated "expense by category" breakdown report endpoint
- `Expense.linkedChargeBatchId` optional cross-reference (Task 9)
- Required-above-threshold receipt attachment policy
- Backoffice Web read-only Expense visibility
- Any account/bank modeling beyond `Fund` (Task 6)
- Vendor/supplier management, purchase orders, approval chains, recurring expenses, tax accounting, budgeting/forecasting
- **Marketplace integration — remains explicitly Post-MVP, unrelated to this capability entirely.**

---

## OUTPUT 8 — Risks

| Risk | How this design prevents it |
|---|---|
| Ledger inconsistency (Expense without a LedgerEntry, or vice versa) | Both written in one `$transaction`; Prisma rolls back atomically on any failure (Task 20). |
| Double counting (Expense mistaken for a Payment/Adjustment reducing debt) | New, distinct `EXPENSE` entry type; `affectsFundBalance` and `getUnitDebt`'s own queries never reference it — structurally can't leak into unit-debt calculations (Task 7/8). |
| Fund balance corruption (going negative, or drifting from Ledger) | Explicit `fund.balance >= amount` check before decrement, read inside the transaction; balance remains reconstructable by replaying `LedgerEntry` exactly as the schema's own invariant already promises (Task 5). |
| Duplicate expense from mobile retry/double-tap | `idempotencyKey` unique constraint + P2002-catch-and-return-existing pattern, reusing the `EnforcementAction` precedent (Task 16). |
| Unauthorized mutation | `RolesGuard` + `@Roles('MANAGER','ACCOUNTANT')`, identical gate to every comparable Finance write; no new permission invented (Task 10). |
| Incorrect reporting (Financial Summary silently wrong once Expenses exist) | `totalExpenses` added to `getFinancialSummary` in the same phase Expense ships — not deferred (Task 14). |
| Silent deletion / history loss | No delete or edit endpoint exists at all; only create and void, both audited and both leaving a permanent Ledger trail (Task 11/15). |
| Concurrent double-void | Status re-checked inside the void transaction itself, not from a pre-fetched copy (Task 17/20). |

---

## OUTPUT 9 — Implementation Plan

| Phase | Scope | Size |
|---|---|---|
| **FIN-EXP-02A** — Domain/schema | `Expense` model, `ExpenseCategory`/`ExpenseStatus` enums, `LedgerEntryType.EXPENSE`, `DocumentReferenceEntityType.EXPENSE`, migration | **S** |
| **FIN-EXP-02B** — Service/repository/ledger | `ExpensePolicy`, `FinanceRepository.createExpense`/`voidExpense`/`listExpenses`/`findExpenseById`, `affectsFundBalance` extension, `getFinancialSummary.totalExpenses` | **M** |
| **FIN-EXP-02C** — API/authorization | `CreateExpenseDto`/`VoidExpenseDto`, controller routes, guards, `AuditService` wiring, `ExpenseCreatedEvent`/`ExpenseVoidedEvent` emission | **S** |
| **FIN-EXP-02D** — Tests/hardening | Unit + integration tests mirroring `finance.repository.spec.ts`'s existing Adjustment/Payment coverage; idempotency-retry test; concurrent-void test; fund-insufficient-balance test | **M** |
| **MOB-EXP-01** — Mobile integration | `expense_api.dart`, controller/state, list/detail/record/void screens, `building_detail_screen.dart` entry point (Task 21) | **M** |

No calendar estimate given, per instruction — relative sizing only.

---

## OUTPUT 10 — Final Recommendation

**B. Backend needs a small extension — complete FIN-EXP-02 first.**

Not (C) "first-class Expense domain" in the sense of a large new subsystem — the extension is genuinely small: one new model, two new enums, one line added to an existing whitelist function, and four endpoints that closely mirror `Adjustment`'s own shape almost line-for-line. But it is real backend work, not zero (ruling out A) — the capability conclusively does not exist today (Task 2), and every part of the design in this document depends on Ledger/Fund mechanics that only the backend can correctly implement (Fund-balance decrement, transactional atomicity, idempotency, audit). Mobile has nothing to build against until FIN-EXP-02A–C ship.

---

## Notes on repository state (verification, not a finding)

`git status --short` in `backend` was run before and after this document was added. Before: the repository's working tree contained only its long-standing, pre-existing accumulation of `_to_delete_*` scratch directories from prior device-bridge sessions in this workspace (documented in earlier phases of this project, unrelated to Finance/Expense work, and not touched here). After adding this document, the only new path is `docs/audit/FIN-EXP-01-EXPENSE-CONTRACT-DESIGN.md`. No `.prisma`, `.ts`, or any production file was created, modified, or staged. `git diff --check` reports clean (nothing was diffed against HEAD in a tracked file, since this is a new untracked file with no whitespace conflicts of its own). No commit was made.

`mobile` and `backoffice-web` were not written to at all in this phase — both were opened read-only, solely to confirm existing Finance UI conventions (e.g. `create_fund_screen.dart`'s dropdown pattern, Backoffice's `payment-reverse-action` confirm-dialog pattern) referenced above for continuity, per the task's explicit permission to inspect them for that purpose only.
