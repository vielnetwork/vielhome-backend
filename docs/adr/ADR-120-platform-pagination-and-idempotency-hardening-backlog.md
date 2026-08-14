# ADR-120 — Platform Pagination & Idempotency Hardening (Backlog)

**Status:** Proposed — no implementation in this ADR
**Context area:** 21_ADRs (platform-wide, cross-domain: Finance, BackOffice, Marketplace, Notifications) — a deliberately-deferred backlog, recorded per this project's own Technical Debt philosophy (`19_Current_Sprint`: "Technical debt is documented. Hidden technical debt is unacceptable. Every known limitation should be recorded. Future improvements receive ADRs.")
**Related:** ADR-072 (the shared `page`/`limit` pagination contract this backlog extends, never replaces); ADR-119 (Finance ↔ Mobile Pagination Contract Alignment — the ADR whose own Non-Goals this backlog collects); ADR-065 (mobile offline queue / `SyncOutboxItems` — the retry pattern that makes idempotency a real, not theoretical, concern)

## Purpose

This ADR is intentionally a **backlog, not a decision**. Five items were identified during the Finance Hardening Pass and the Finance ↔ Mobile Contract Alignment work (ADR-119) as real, confirmed gaps that are explicitly **platform-wide** in nature — fixing any one of them only inside Finance would be inconsistent (Finance would end up on a different convention than every other domain) and was explicitly rejected as an approach during ADR-119's own scoping. Recording them here, together, means they get evaluated and designed as one coherent cross-domain decision when picked up, rather than accreting as five separate, uncoordinated patches to five different modules over time.

Each item below should become (or feed into) its own ADR at implementation time, per this project's normal ADR lifecycle (Proposal → Discussion → Review → Approval → Implementation) — this document is the Proposal stage for all five, not a pre-approval of any of them.

## Item 1 — Deterministic Pagination Ordering

**Problem:** every paginated repository method surveyed platform-wide — 19 in total (Finance: 8, BackOffice: 9, Marketplace: 2, Notifications: 1) — orders by a single non-unique column (typically `createdAt: 'desc'`), with no secondary tiebreaker. Two rows created in the same millisecond (realistic under load, or from a bulk/seed operation) have no guaranteed relative order across repeated queries or across a page boundary — a row can theoretically appear on two consecutive pages, or be skipped entirely, depending on how the database resolves ties internally between calls.

**Proposed direction:** add a unique secondary sort key to every affected `orderBy` — `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` (or the domain's natural unique column) — across Finance, BackOffice, Marketplace, and Notifications together, in one coordinated pass, not domain-by-domain. Doing Finance alone was explicitly rejected during ADR-119's scoping specifically to avoid a half-fixed platform.

## Item 2 — Marketplace Pagination Migration

**Problem:** `browseProviders()`'s own already-disclosed stopgap (`limit: 50`, no real page/metadata reading) predates ADR-072 and was never migrated. Same shape of mobile-truncation risk ADR-119 just closed for Finance, unaddressed for Marketplace.

**Proposed direction:** adopt `PaginatedResult<T>`/`ApiClient.getPaginated<T>` (now real, tested primitives in `core/network` as of ADR-119) unchanged — no new mobile-side primitive work needed, only wiring Marketplace's own API/provider layer to them, plus the equivalent per-screen pagination-strategy evaluation ADR-119 did for Finance (which Marketplace screens need true UI pagination vs. a bounded fetch-all).

## Item 3 — Platform Pagination Hardening (General)

**Problem:** beyond ordering (Item 1) and Marketplace specifically (Item 2), the review behind ADR-119 surfaced that BackOffice's own paginated staff queues and Notifications' listing have never been re-audited against ADR-072's contract the way Finance and Marketplace's public listing were. Whether their mobile/BackOffice-web consumers correctly read `metadata.pagination` at all has not been verified.

**Proposed direction:** a dedicated audit pass (structured like the investigation behind `finance-pagination-mobile-review`) across BackOffice's and Notifications' consumers, before any code changes — confirm which consumers, if any, have the same "reads `data`, discards `metadata`" gap Finance and Marketplace both had.

## Item 4 — Cursor Pagination

**Problem:** the platform's pagination contract is offset-based (`page`/`limit`). Offset pagination has a well-known consistency weakness under concurrent writes: if a row is inserted or deleted ahead of a page boundary between two requests, a client can see a duplicate or miss a row entirely when paging forward — a related but distinct risk from Item 1's ordering-tiebreaker gap (this affects even a fully-deterministic sort order, purely because of concurrent mutation between page fetches).

**Proposed direction:** not a drop-in replacement decision. `08_API_Architecture`'s frozen Page/Limit convention (ADR-072) is a Frozen Decision — moving to cursor-based pagination would itself need to go through this project's full ADR process, including whether it replaces offset pagination platform-wide or is added as an alternative for specific high-write-concurrency endpoints only. Recorded here as a live open question, not a recommendation either way.

## Item 5 — Idempotency-Key Architecture

**Problem:** no idempotency-key convention exists anywhere in this codebase today. This is not itself a pagination issue, but it was surfaced by the same review because it shares a root cause with the mobile offline-retry pattern (`SyncOutboxItems`, ADR-065): a retried `POST` against a non-naturally-idempotent endpoint can double-apply if it "succeeded" server-side but the client's response was lost (e.g. network drop after a payment report succeeds but before the mobile client receives the 201). Finance's own payment-reporting and adjustment-creation endpoints are exactly the kind of non-idempotent write this would protect.

**Proposed direction:** a platform-wide idempotency-key convention (client-generated key header, server-side dedup window) — evaluated for feasibility against this codebase's existing request/response envelope and audit-logging infrastructure, likely as its own dedicated ADR given the schema/infrastructure implications (a dedup-key table or cache, a TTL policy, and a decision on which endpoints actually need it vs. which are already naturally idempotent).

## Non-Goals (of this ADR)

- **No implementation of any of the five items above.** This ADR records and scopes the backlog; it does not decide alternatives, does not write code, and does not commit to a timeline.
- **Does not reopen ADR-072 or ADR-119's own scope.** Both remain closed/frozen as shipped; this ADR only tracks what was explicitly deferred out of them.
- **Does not prioritize the five items relative to each other or to other roadmap work** (Notifications, Gamification, Marketplace Foundation per `19_Current_Sprint`'s own Future Milestones) — that is a product/roadmap decision outside this ADR's scope.

## Related Documents

- ADR-072 — the frozen Page/Limit pagination contract.
- ADR-119 — Finance ↔ Mobile Pagination Contract Alignment (closed; the ADR whose Non-Goals this backlog collects).
- ADR-065 — mobile offline queue (`SyncOutboxItems`) — the pattern making Item 5 a live, not theoretical, concern.
- `finance-pagination-mobile-review` — the investigation report that first surfaced Items 1–3 as platform-wide, not Finance-specific.
- `19_Current_Sprint` — Technical Debt philosophy this ADR follows ("every known limitation should be recorded").

## Future Review

Revisit this backlog the next time any of Marketplace's pagination, a BackOffice/Notifications pagination audit, or an idempotency-key need is scheduled as active work — at that point, split the relevant item out into its own dedicated ADR following this project's normal lifecycle, and mark it here as promoted (with a forward reference) rather than duplicating the write-up.
