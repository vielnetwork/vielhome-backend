# ADR-125 — Finance Canonical Money Unit: Iranian Rial (IRR)

**Status:** Accepted / Frozen
**Date:** 2026-08-10
**Scope:** All VielHome MVP Finance storage, APIs, Mobile, Backoffice, reports/exports, and future payment integrations

## Context

Finance persists monetary values as Prisma `Int` fields and exposes them as JSON numbers, but the original schema commentary used the ambiguous phrase “Toman/Rial.” The schema has no currency column, while some uncommitted validation comments and fixtures assumed Toman. Rial and Toman differ by a factor of ten, so leaving the unit implicit makes display, reporting, and payment-gateway integration unsafe.

The implementation contains no conversion layer and existing values have always passed unchanged between DTOs, persistence, calculations, APIs, Mobile, CSV, ledger entries, and balances. There is no authoritative evidence that persisted values were converted from, or must be converted to, a different unit. This ADR freezes their meaning; it does not alter their numeric value.

## Decision

### Canonical unit and currency

All Finance monetary integer values represent **whole Iranian Rial**. The canonical MVP Finance currency is **IRR**. Storage and API unit are Rial; Mobile and Backoffice user-facing display unit is Rial.

Finance APIs serialize monetary values as JSON numbers representing whole Rial. No fractional monetary unit is supported in the current MVP. Existing Prisma `Int` Finance fields are interpreted as whole Rial without multiplication, division, backfill, or migration.

Example user-facing display: `50,000,000 ریال` (or an equivalently localized Rial label). Toman labels and Toman display are prohibited in MVP.

### Single-currency MVP

MVP Finance is globally single-currency. The absence of a currency column is acceptable only because IRR is frozen globally here. Multi-currency is unsupported. Future multi-country or multi-currency support requires a separate ADR plus explicit schema, migration, and API design.

### Reports and integrations

All exports and reports represent monetary values in Rial. Generic amount fields must be documented with their Rial unit at the Finance contract boundary.

Future payment-gateway integrations must send and receive amounts according to the gateway's Rial contract without introducing Toman as VielHome's internal unit. If an external provider uses different semantics, any conversion must be isolated in a dedicated integration adapter; it must not change VielHome's canonical persisted/API unit.

### Prohibited ambiguity and conversion

The following are prohibited:

- comments or contracts describing Finance values as “Toman/Rial”;
- Finance API documentation that leaves a monetary amount's unit unspecified;
- Toman labels or assumptions in Mobile, Backoffice, reports, or CSV;
- silent Rial/Toman conversion;
- multiplying or dividing Finance values by ten outside an explicitly reviewed external-integration adapter;
- mixing Rial and Toman in persisted Finance data.

## Data-semantics audit

The schema, migrations, seed/fixtures, Finance calculations, tests, Mobile Finance implementation, APIs, and ADRs were inspected. Persistence and calculation paths consistently treat monetary values as opaque integers and pass them through without a factor-of-ten transform. Mobile currently renders raw numeric values without a unit; no production migration or historical currency marker proves a Toman encoding. The only explicit Toman assumptions were comments and tests in uncommitted validation-hardening work.

Outcome: **test/fixture and documentation alignment only**. Existing numeric values are re-labeled as Rial without numeric conversion. No schema or data migration is required or authorized by this ADR.

## Consequences

Benefits:

- one unambiguous internal and external MVP unit;
- direct compatibility with Rial-denominated payment contracts;
- no hidden conversions in accounting, reports, or UI;
- simpler ledger and balance reasoning across Mobile and Backoffice.

Tradeoffs:

- users accustomed to Toman must read Rial labels and larger displayed numbers;
- existing UI that shows an unlabeled number must add a Rial label when touched;
- future multi-currency support requires explicit schema/API migration and a new ADR.

Prisma `Int` keeps every stored value exactly representable as a JavaScript number, but the domain currently has no explicit business maximum below the database integer ceiling. Adding product-specific upper bounds remains technical debt and is not a reason to change read serialization in this phase.
