# ADR-122: Cases hardening and Documents integration

## Status

Accepted — 2026-08-07

## Context

The remaining Cases backend lists were unbounded, fraud evidence used a
single overwritable field, merged Cases retained an invalid reopen path, and
polymorphic `CASE` document references did not validate their target or apply
Case visibility when accessed through direct Documents routes.

## Decision

- Case lists, messages, assignment history, and member Support “My Cases” use
  the shared `page`/`limit` parser and `metadata.pagination` response contract.
  Visibility and internal-message predicates are applied before count and
  pagination. Stable IDs break timestamp ties.
- Merged Cases cannot be reopened or merged again. Merge targets must be
  active, unmerged, and in the same building.
- Fraud evidence is stored as append-only `FraudCaseEvidence` rows carrying
  notes, author, and creation timestamp. `FraudCase.evidenceNotes` remains a
  latest-value compatibility projection; it is updated in the same transaction
  as the history insert.
- Creating a `CASE` document reference calls the existing `CasesService` and
  therefore reuses `CasePolicy`: the Case must exist in the Document's building
  and be visible to the caller. Explicit versions must belong to the target
  Document.
- CASE attachment listing and direct document detail, version-history, and
  download paths reapply Case authorization. Missing/deleted targets fail
  closed. Existing Document visibility and object-storage download rules remain
  unchanged.

## Consequences

One migration adds `fraud_case_evidence`; no Case or Document schema change is
required. Existing scalar evidence is backfilled with its best-known
`updatedAt` timestamp and an explicitly unknown author because the legacy row
stored no attribution. There is no Case deletion endpoint, so normal
application lifecycle cannot create an orphan. Legacy or externally-created
dangling polymorphic references are denied rather than exposed. Deleting,
restoring, or editing document attachments remains out of scope.
