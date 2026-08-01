# ADR-109 — Maintenance Mode & Feature Flags

**Status:** Proposed — pending the operator's own `prisma migrate dev`/`generate`/`db:seed:rbac`/build/unit/e2e verification (this sandbox cannot run any of them for schema-changing work — see "Build / Unit / E2E Verification" below)
**Context area:** 21_ADRs (Backend / Backoffice), Operational Readiness — Stage 2 of the Backoffice completion roadmap
**Related:** ADR-098 (Backoffice RBAC Foundation — item 9 originally reserved the bare `FEATURE_FLAGS` key this ADR now supersedes), ADR-099/ADR-102 (VIEW/MANAGE permission-pair convention), ADR-108 (Monitoring & System Health — Stage 1, same module-wiring template), ADR-107 (E2E cleanup discipline — this ADR's own e2e suite follows its shared-fixture rules and adds a new category of cross-suite risk it explicitly designs around)

## Context

ADR-098 reserved two permission keys — `SYSTEM_SETTINGS` and `FEATURE_FLAGS` — as placeholders for future platform-wide configuration domains, but neither had any actual endpoint, model, or logic behind it; both were pure catalog entries granted to `Technical Admin`/`Super Admin` with nothing to gate. This is Stage 2 of the 10-stage Backoffice completion roadmap (Stage 1: ADR-108 Monitoring, now Closed). It builds two small, independent, self-contained config domains:

1. **Global Maintenance Mode** — a platform-wide on/off switch that, when enabled, makes the platform return HTTP 503 for most traffic, with a small, explicit allowlist of routes that must keep working.
2. **Feature Flags** — a centralized, generic on/off toggle registry for engineering/ops use, distinct from the customer-facing `FeatureGrant` entitlement model (subscription-plan-driven, per-building — an entirely different, pre-existing concept).

Neither domain touches provider configuration (SMS/Email/Payment/Storage credentials) — that is explicitly out of scope for this stage (see Non-Goals) and deferred to a later stage (Global Provider Settings).

## Decision — Permission Keys

Per this stage's explicit design mandate, both domains get a real VIEW/MANAGE split — four new keys: `MAINTENANCE_MODE_VIEW`, `MAINTENANCE_MODE_MANAGE`, `FEATURE_FLAGS_VIEW`, `FEATURE_FLAGS_MANAGE`. This is a deliberate departure from the `SYSTEM_SETTINGS`/`FEATURE_FLAGS`-as-single-key precedent ADR-098/ADR-102 established for small, uniform domains — this stage's own instructions specifically called for separate view/manage permissions here, so that precedent is not followed for these two domains.

The old bare `FEATURE_FLAGS` key is **superseded**, not removed: Postgres enum values cannot be safely dropped without a full column rewrite, and this codebase's migration discipline (every prior permission migration, including ADR-108's own) is additive-only — so `FEATURE_FLAGS` stays in the enum, stays granted to whatever role already holds it, but no new code checks it and this stage's seed changes do not grant it to anything new. `SYSTEM_SETTINGS` is untouched entirely — it is not this ADR's concern (no "Maintenance Mode" or "Feature Flags" semantics were ever attached to it).

`Technical Admin` (and `Super Admin`, which holds every permission automatically) gains all four new keys together, matching this seed file's own established convention of never granting a domain's `MANAGE` key without also granting its `VIEW` key to the same role.

## Decision — Maintenance Mode

- **Endpoints:** `GET /api/v1/backoffice/maintenance-mode` (status; `MAINTENANCE_MODE_VIEW`), `PATCH /api/v1/backoffice/maintenance-mode` (toggle; `MAINTENANCE_MODE_MANAGE`, mandatory `reason`, optional customer-facing `message`).
- **Storage:** `MaintenanceModeState`, a deliberate single-row table — every read/write targets the one row whose `id` is the fixed literal `"singleton"`. There is no DB-level constraint enforcing exactly one row (Postgres has no native singleton-table primitive); this is an application-level convention upheld entirely by `MaintenanceModeService` always calling `upsert({ where: { id: 'singleton' } })` and nothing else ever using a different id.
- **Safe default:** a fresh environment with no state row yet defaults to `enabled: false`. If loading state at boot ever fails (e.g. a transient DB error, or this migration not yet applied in some environment), the service also defaults to `enabled: false` rather than risking an accidental maintenance-mode-on state. The platform can never silently end up in maintenance mode by omission.
- **In-memory cache, not a per-request DB read:** `MaintenanceModeService.isEnabled()` is a synchronous read of a cached value, loaded once at boot (`onModuleInit`) and updated immediately on every successful toggle. `MaintenanceModeMiddleware` calls this on every single incoming HTTP request — a database round-trip on every request (including the overwhelming common case of maintenance mode being off) would add real, avoidable latency to the entire platform's hot path. This is a deliberate single-instance-deployment simplification: a multi-instance deployment would need a shared invalidation mechanism (Redis pub/sub, or a short TTL re-poll) to keep every process's cache consistent — out of scope for this stage (see Future Review); this codebase currently runs as a single Node process.
- **The global gate — `MaintenanceModeMiddleware`:** applied to every route in `AppModule.configure()`, registered immediately after the existing `RequestContextMiddleware` (in the same `.apply(...)` call, so `req.requestId` is always set first). Nest middleware always runs before every guard (global, controller, or route scope), so this middleware cannot inspect `req.user` — the exemption list is deliberately **path-based only**, matching the literal design mandate ("specify which routes stay active"), never identity-based. Three exempt path-prefix families:
  - `/api/v1/health*` — infrastructure probes must never see the platform as "down" just because staff put it into maintenance.
  - `/api/v1/auth*` — essential authentication (OTP request/verify, token refresh) stays reachable for everyone; this alone grants no access to anything else while blocked.
  - `/api/v1/backoffice/maintenance-mode*` — the maintenance-mode endpoints themselves.
- **Admin-lockout prevention:** entirely a consequence of the third exemption above. Whoever holds `MAINTENANCE_MODE_MANAGE` can always reach the toggle endpoint to turn maintenance mode back off, even while it is currently on — there is no separate "emergency disable" mechanism because none is needed. Anything that reaches an exempted path still goes through the normal guard chain afterward: an unauthenticated or under-permissioned caller hitting `/backoffice/maintenance-mode` still gets a normal 401/403, exactly as it would with maintenance mode off. The middleware only ever adds a 503 short-circuit for everything else; it never grants access to anything.
- **Response shape while blocking:** a manually-constructed `503` using this codebase's standard error envelope (`errorResponse(...)`), built directly in the middleware rather than by throwing — Nest's global `AllExceptionsFilter` is guaranteed to apply within the guard/interceptor/controller pipeline, but raw Express-style middleware (registered via `MiddlewareConsumer`, running before that pipeline) has no such guarantee, so this avoids relying on undefined behavior for a safety-critical response path. A new `ServiceUnavailableError` (503) was added to the shared `AppError` taxonomy (`src/common/errors/app-error.ts`) for this — instantiated for its `code`/`httpStatus`/`message`, not thrown.
- **Idempotency:** re-affirming the same `enabled` value the state already has is a safe no-op with respect to platform behavior, but is still written and audited as a genuine action — a reaffirmed "still in maintenance, still for this reason" is meaningful operational history, not noise to suppress.

## Decision — Feature Flags

- **Endpoints:** `GET /api/v1/backoffice/feature-flags` (list, paginated/searchable; `FEATURE_FLAGS_VIEW`), `GET /api/v1/backoffice/feature-flags/:key` (detail; `FEATURE_FLAGS_VIEW`), `POST /api/v1/backoffice/feature-flags` (create; `FEATURE_FLAGS_MANAGE`, mandatory `reason`), `PATCH /api/v1/backoffice/feature-flags/:key` (toggle `enabled` and/or update `description`; `FEATURE_FLAGS_MANAGE`, mandatory `reason`).
- **Storage:** `FeatureFlag` — `key` (unique, `SCREAMING_SNAKE_CASE`, immutable after creation), `label`, `description`, `enabled` (defaults to `false` — a new flag never starts live), `updatedById`/`updatedAt`.
- **No delete route in Phase 1:** a flag can be created and toggled, never removed. Any code elsewhere that checks a flag by key never silently starts hitting a not-found/undefined state because someone deleted the row it depended on (see Non-Goals).
- **No rename route:** `key` is immutable once set, for the same reason.
- **Update requires an actual change:** `PATCH` rejects a request where neither `enabled` nor `description` is provided (`ValidationError`, 400) — a reason-only request with nothing else changing would otherwise write a misleading audit entry describing a change that never happened.
- **Duplicate-key creation** is rejected with `DuplicateError` (409), matching this codebase's existing conflict-error convention.

## Implementation

New module, following the exact wiring template `MonitoringModule`/`SchedulerModule` already established: import `BackOfficeModule` (for `PlatformRolesGuard`'s own `BackOfficeRepository` dependency), import `BackofficeRbacModule` (for `PermissionsGuard`), declare `PlatformRolesGuard` as a local provider (`BackOfficeModule` does not export it).

- `src/modules/maintenance/maintenance.module.ts` — new module, registered in `AppModule` after `MonitoringModule`. Exports `MaintenanceModeService` (needed outside the module, by `AppModule`'s own middleware wiring).
- `src/modules/maintenance/controller/maintenance-mode.controller.ts`, `feature-flag.controller.ts` — the routes.
- `src/modules/maintenance/application/maintenance-mode.service.ts`, `feature-flag.service.ts` — all logic.
- `src/modules/maintenance/application/dto/*.ts` — `ToggleMaintenanceModeDto`, `CreateFeatureFlagDto`, `UpdateFeatureFlagDto`.
- `src/common/middleware/maintenance-mode.middleware.ts` — the global gate.
- `src/common/errors/app-error.ts` — added `ServiceUnavailableError` (503) / `'SERVICE_UNAVAILABLE'` to the existing `AppErrorCode` union.
- `src/app.module.ts` — one new module import/registration; `configure()` now applies `MaintenanceModeMiddleware` immediately after `RequestContextMiddleware` in the same call (order matters — see Decision above).

## Schema / Migration / Seed

- `prisma/schema.prisma` — four new additive `PermissionKey` enum values (`MAINTENANCE_MODE_VIEW`, `MAINTENANCE_MODE_MANAGE`, `FEATURE_FLAGS_VIEW`, `FEATURE_FLAGS_MANAGE`), two new back-relations on `Person` (`maintenanceModeUpdatedBy`, `featureFlagsUpdatedBy`), and the two new models (`MaintenanceModeState`, `FeatureFlag`) described above.
- `prisma/migrations/20260801120000_add_maintenance_feature_flags/migration.sql` — additive only, hand-written in this sandbox in the exact shape `prisma migrate dev` itself generates (matching this repo's own prior multi-value `ALTER TYPE ... ADD VALUE` migrations, e.g. `20260730170000_add_adr102_permissions`, and its own prior nullable-FK `ON DELETE SET NULL ON UPDATE CASCADE` convention, e.g. `AuditLegalHold.releasedById`): four `ALTER TYPE` statements, two `CREATE TABLE` statements, one `CREATE UNIQUE INDEX` (`FeatureFlag.key`), two `ADD CONSTRAINT` foreign keys. **This sandbox cannot run `prisma generate` (see Build/Unit/E2E Verification) and therefore cannot run `prisma migrate dev` to have Prisma itself generate this file** — it was written by hand, carefully matching every convention Prisma's own generator uses elsewhere in this repo's migration history. The operator must review it alongside the schema diff before running `prisma migrate dev`.
- `prisma/seed/rbac.seed.ts` — four new `PERMISSIONS` entries; `Technical Admin` gains all four new keys (grouped with its other platform-wide operational/system keys); `Technical Admin`'s `ROLE_DESCRIPTIONS` entry updated to mention maintenance mode. `FEATURE_FLAGS`/`SYSTEM_SETTINGS` grants are untouched — nothing is revoked.

## Testing

- `src/modules/maintenance/application/maintenance-mode.service.spec.ts` — boot/safe-default behavior (no row yet, real row present, boot read failure), `setEnabled` writing through to the DB and cache atomically, `MaintenanceModeEnabled` vs `MaintenanceModeDisabled` audit action naming, idempotent re-affirmation.
- `src/modules/maintenance/application/feature-flag.service.spec.ts` — pagination, `NotFoundAppError`/`DuplicateError` on the relevant paths, safe-default `enabled: false` on creation, the "at least one field" validation rule on update, before/after audit metadata.
- `src/common/middleware/maintenance-mode.middleware.spec.ts` — fully mocked `MaintenanceModeService`, zero real state: passthrough when disabled; passthrough for all three exempt-path families when enabled (including a `health`/`auth`/`maintenance-mode`-adjacent-but-not-actually-matching path, proving the prefix match requires a boundary and can't be fooled by e.g. `/api/v1/authorization-audit`); 503 with the standard error envelope for a non-exempt path when enabled; no leakage of internals in the block response; `requestId` fallback.
- `test/maintenance.e2e-spec.ts` — two independent `describe` blocks (Maintenance Mode, Feature Flags), each following the same 401/403×2/403-no-grant/granted-live/revoked-live shape ADR-108's own e2e suite established. **Deliberately never writes `enabled: true` to the real, shared `MaintenanceModeState` singleton row** — see the file's own prominent top-of-file safety note and the dedicated subsection below for why.

### Why the e2e suite never flips the real maintenance-mode flag on

`npm run test:e2e` runs every `*.e2e-spec.ts` file as a separate, concurrent Jest worker process, all pointed at the same shared dev Postgres database (ADR-107's own foundational fact about this test suite). `MaintenanceModeService.isEnabled()` is read into an in-memory cache once, at each app instance's own `onModuleInit()`, and never re-polled afterward. If this e2e suite ever wrote `enabled: true` to the real row — even briefly, even inside a `try`/`finally` that reset it milliseconds later — any OTHER suite's app instance that happened to boot during that window would latch "maintenance mode ON" into its own cache for its entire lifetime, and would then 503-block almost all of its own subsequent requests. That is a cascading failure across the *entire* parallel e2e run, categorically worse than any single incident ADR-107 catalogued (which were narrow, single-suite FK/cleanup races, never a whole-run failure mode).

Given that risk, the e2e suite's `PATCH` calls are restricted to `enabled: false` only — safe and idempotent regardless of the row's current state, since the row is never anything but `false` for the platform's entire lifetime under this design. This still fully exercises the HTTP-wired contract: RBAC (401/403 across every combination), DTO validation (missing `reason` → 400), the write path, and audit-log creation. The actual 503-blocking behavior and all three path exemptions are instead proven by the middleware's own fully-mocked, zero-shared-state unit test, which is the safe place to exercise that logic.

## Build / Unit / E2E Verification

**This sandbox could verify meaningfully less for this stage than for ADR-108.** ADR-108 added one new `PermissionKey` enum value, which could be safely hand-patched into the locally-generated (but not regenerated) Prisma Client's `.d.ts` for verification purposes, since no code performed a runtime property lookup on that type. This stage adds **two entirely new Prisma models** (`MaintenanceModeState`, `FeatureFlag`) with real delegate methods (`findUnique`, `upsert`, `create`, `update`, `findMany`, `count`) — safely faking that surface would mean hand-authoring a materially large slice of Prisma's own generated client types and runtime behavior, which is a fundamentally different (and much riskier) exercise than adding one property to an existing enum object, and was judged not worth the risk of masking a real mistake behind a hand-rolled shim.

What this sandbox *could* still verify:

- `npx eslint` on every new/changed file (scoped — no `--fix` was run on `prisma/seed/rbac.seed.ts` or `test/helpers/e2e-identity.ts`, both of which have pre-existing, out-of-scope prettier violations on lines this stage did not touch; every line this stage actually added or changed in those two files is lint-clean).
- `npx tsc --noEmit` across the whole project: **exactly 27 errors, every single one attributable to the stale (not-yet-regenerated) Prisma Client missing the four new enum values and two new models** — `Type '"MAINTENANCE_MODE_VIEW"' is not assignable to type 'PermissionKey'`, `Property 'featureFlag' does not exist on type 'PrismaService'`, and so on. No other, unrelated error appeared. This is meaningful signal (the new code is not otherwise structurally broken) but is explicitly **not** a substitute for a real, green `tsc`/`npm run build` against a real generated client.
- `npm test` was not run in-sandbox: `ts-jest` type-checks by default, so any spec file that imports the new service/module code hits the exact same missing-Prisma-type errors as `tsc` above and cannot execute.

**The operator must, in order, on their own machine:** `npx prisma migrate dev` (applies `20260801120000_add_maintenance_feature_flags`), `npx prisma generate`, `npm run db:seed:rbac` (idempotent), then `npm run build`, `npm test`, `npm run test:e2e`. This ADR is not Closed until that full sequence is confirmed green (or any failure has been triaged per the roadmap's own Verification Gate — isolated rerun, root-cause, compare against ADR-107's known patterns, before attributing anything to this stage).

## Non-Goals (Phase 1)

Explicitly out of scope for this ADR, listed exhaustively:

- Any provider configuration (SMS/Email/Payment/Storage credentials) — explicitly deferred to a later stage (Global Provider Settings).
- Deleting or renaming a feature flag once created.
- A Maintenance Mode or Feature Flags UI/Dashboard.
- Per-building or per-tenant maintenance mode (this is a single, global, platform-wide switch only).
- Per-building or per-user feature-flag targeting/rollout percentages (this is a single global on/off per flag — no gradual-rollout or segment-targeting logic).
- Scheduled/timed maintenance windows (enabling/disabling is always an explicit, immediate staff action).
- Multi-instance cache invalidation for the maintenance-mode flag (see Future Review) — this codebase runs as a single Node process today.
- Any broader Backoffice-wide exemption from the maintenance-mode block beyond the three named route families — no route or permission is exempted "because it's Backoffice," only the three explicitly named categories are.
- A `FEATURE_FLAGS`/`SYSTEM_SETTINGS` migration/cleanup (revoking the old bare key from whatever already holds it, or repurposing `SYSTEM_SETTINGS`) — both are left exactly as they were.

## Consequences

- Positive: the platform gains its first real global maintenance-mode mechanism and its first real centralized feature-toggle registry, both fully RBAC-gated, fully audited, with a structural (not just documented) admin-lockout-prevention guarantee.
- Positive: zero new npm dependencies.
- Neutral: every existing route's behavior is completely unchanged while maintenance mode is off (the overwhelming common case) — the new middleware's only cost per request is one synchronous boolean read.
- Residual, tracked for later (see Future Review): no multi-instance cache consistency; no scheduled maintenance windows; no per-flag rollout targeting; the old bare `FEATURE_FLAGS` permission key remains in the enum and in the seed, doing nothing, until a future cleanup deliberately addresses it.

## Future Review

- **Multi-instance maintenance-mode consistency:** if this codebase is ever deployed across more than one Node process/instance, `MaintenanceModeService`'s in-memory cache needs a cross-instance invalidation mechanism (Redis pub/sub on toggle, or a short TTL re-poll) so every instance reflects a toggle promptly. Not needed today.
- **Scheduled maintenance windows:** an "enable maintenance mode from X to Y" scheduling feature, if ever requested, would need its own design (likely reusing the existing Scheduler/BullMQ infrastructure from ADR-036).
- **Feature flag rollout targeting:** percentage-based or per-building/per-segment flag evaluation, if ever needed, is a materially larger feature than this Phase 1 registry and should get its own ADR rather than being bolted onto this simple on/off model.
- **`FEATURE_FLAGS`/`SYSTEM_SETTINGS` cleanup:** a future ADR could deliberately migrate whatever (if anything) holds the old bare `FEATURE_FLAGS` key onto the new split pair, and/or decide what `SYSTEM_SETTINGS` is actually for, now that a real Feature Flags feature exists alongside it.
