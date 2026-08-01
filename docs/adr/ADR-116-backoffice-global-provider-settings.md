# ADR-116 — Global Provider Settings

**Status:** Accepted — Closed (2026-08-01)
**Context area:** 21_ADRs (Backend / Backoffice), Global Provider Settings — Stage 9 of the Backoffice completion roadmap
**Related:** ADR-088 (real SMS/Email/Push providers — `EmailProviderService`/`SmsProviderService`/`PushProviderService`, all reused unchanged here), ADR-109 (Maintenance Mode & Feature Flags — its own schema comment explicitly named "SMS/Email/Payment/Storage credentials... deferred to a later stage (Global Provider Settings)," the exact gap this ADR closes; also the direct structural precedent this ADR mirrors — singleton-shaped settings service, `isEnabled()` in-memory cache, VIEW/MANAGE permission pair, mandatory-reason audit trail), ADR-110 (Operational Dashboard — the "import the settings module directly for its exported service" wiring pattern this ADR reuses for `NotificationsModule` → `ProviderSettingsModule`)

## Context

This is Stage 9 of the 10-stage Backoffice completion roadmap (Stages 1-8, all Closed). ADR-109's own schema comment, written when `MaintenanceModeState`/`FeatureFlag` were added, explicitly flagged this exact gap and deferred it: "Neither stores any provider configuration (SMS/Email/Payment/Storage credentials) — that is explicitly deferred to a later stage (Global Provider Settings)."

A real-repo-state check confirmed the gap is real and unchanged since that comment was written: `EmailProviderService`/`SmsProviderService`/`PushProviderService` (ADR-088) each read their vendor credentials from env vars only (`EMAIL_PROVIDER_API_KEY`, `SMS_PROVIDER_ACCOUNT_SID`, etc., via `ConfigService`), and each exposes an `isConfigured()` boolean gate with **no other on/off control anywhere** — the only way to stop the platform from calling SendGrid/Twilio/FCM today is to unset an env var and redeploy. There is no Backoffice-manageable settings surface for any provider.

A `Payment` provider was also named in ADR-109's own deferred list, but this codebase has no external payment gateway to manage — `grep` confirms Finance is entirely internal ledger/charge/payment tracking with no third-party payment API integration anywhere. `Storage` (S3/MinIO, ADR-087) does have external credentials and an `isConfigured()` gate, but is deliberately excluded from this stage's live kill switch (see Decision below) — leaving Email/SMS/Push as this stage's real, in-scope surface.

## Decision — Never Store or Expose a Credential

This stage's entire design is bounded by this codebase's own "never expose credentials/internal details" principle: `ProviderSetting` (the new model) stores **no credential of any kind** — no API key, account SID, auth token, or private key. The `GET` endpoint's `configured` field is a boolean, computed by calling each provider service's own pre-existing `isConfigured()` (env-var presence only) — never the underlying value. Every write this stage adds (`enabled`, `reason`, `updatedById`) is operational metadata about a kill switch, not a secret.

## Decision — A Real, DB-Backed, Per-Provider Kill Switch, Not an Informational Registry

`ProviderSettingsService.isEnabled(key)` is consulted directly inside `NotificationDispatchProcessor`, alongside each channel's existing `isConfigured()` check — `this.emailProvider.isConfigured() && this.providerSettings.isEnabled('EMAIL') && recipient.email`, and the equivalent for SMS/PUSH. An administratively disabled provider falls back to the **exact same stub path** an unconfigured one already uses (same log line, same `markDeliverySent` call) — disabling a provider is never a silent drop or a new failure mode, it degrades to the same pre-ADR-088 behavior every environment without a real provider already relies on. This is a deliberate design constraint: this codebase's own principle against "incomplete endpoints for high-risk operations" means a MANAGE mutation that only writes a database row with no real runtime effect would not be a complete capability — every key this stage introduces has genuine, live-wired behavior.

## Decision — STORAGE Is Excluded From Phase 1 (Not a Fourth `ProviderKey`)

`ProviderKey` has exactly three values: `EMAIL`, `SMS`, `PUSH`. `StorageService.assertConfigured()` throws a hard `UnexpectedAppError` when misconfigured — unlike Email/SMS/Push, there is no established, already-safe stub-fallback path for Storage to degrade to. Documents upload/download has no graceful degradation if storage were disabled mid-flight; wiring a live `STORAGE` kill switch would mean either inventing a new failure mode for Documents (out of scope) or adding a fourth enum value with no real runtime effect (rejected by the same "no incomplete high-risk endpoint" reasoning above). STORAGE stays entirely out of this stage — no schema value, no endpoint row, no Non-Goal caveat needed beyond this explanation, since it simply isn't part of the surface at all.

## Decision — Permission Keys: A New VIEW/MANAGE Pair, `PLATFORM_ADMIN`-Gated

No dormant `PermissionKey` was available to reuse (confirmed the same way ADR-115 confirmed it for its own stage — every existing key is already wired to a route). `PROVIDER_SETTINGS_VIEW`/`PROVIDER_SETTINGS_MANAGE` are new, following the same real VIEW/MANAGE split ADR-109/ADR-111-115 already established for a domain with a genuine mutating action.

Both routes are gated `PLATFORM_ADMIN` (the legacy floor), matching `MaintenanceModeController`'s own precedent exactly — disabling a live, platform-wide SMS/Email/Push provider is comparably sensitive to a global maintenance-mode toggle, not a narrow, domain-scoped action any lower legacy rank should reach. Granted to `Technical Admin` in the seed matrix, the same role that already holds `MAINTENANCE_MODE_VIEW`/`MANAGE`, `FEATURE_FLAGS_VIEW`/`MANAGE`, and `SYSTEM_SETTINGS` — provider enable/disable is the same category of platform-wide operational/system concern this role's own description already centers on.

## Decision — Endpoints

- `GET /api/v1/backoffice/provider-settings` — returns all three provider keys (`EMAIL`, `SMS`, `PUSH`), each with `enabled` (DB-backed, defaults `true`), `configured` (env-var presence, reused from each provider's own `isConfigured()`), `reason`, `updatedAt`, `updatedById`. A key with no row yet still appears in the response (`enabled: true`, `reason: null`, `updatedAt: null`) — the full three-key set is always the shape, never a partial list dependent on which rows happen to exist. Gated `PLATFORM_ADMIN` + `PROVIDER_SETTINGS_VIEW`.
- `PATCH /api/v1/backoffice/provider-settings/:key` — mandatory `reason` (`ToggleProviderSettingDto`, same shape as `ToggleMaintenanceModeDto`). Upserts the row by `key`, updates the live in-memory cache immediately, and audits (`ProviderEnabledByAdmin`/`ProviderDisabledByAdmin` — distinct actions, matching `MaintenanceModeEnabled`/`MaintenanceModeDisabled`'s own naming shape). An unknown `:key` 404s (`NotFoundAppError`) rather than silently creating an unrecognized row. Gated `PLATFORM_ADMIN` + `PROVIDER_SETTINGS_MANAGE`.

## Decision — In-Memory Cache, Same Hot-Path Discipline as `MaintenanceModeService`

`ProviderSettingsService.isEnabled(key)` is a synchronous, in-memory `Map` read — `NotificationDispatchProcessor` consults it on every single dispatch attempt for Email/SMS/Push, and a database round-trip there would be real, avoidable latency on the platform's busiest queue consumer. The cache loads at boot (`onModuleInit`) and refreshes immediately after every successful `setEnabled` call, with no polling and no cross-instance invalidation — the identical, already-documented single-process limitation `MaintenanceModeService` discloses (this codebase currently runs as a single Node process).

The safe default — before boot-load completes, if it fails, or for a key with no row yet — is always `enabled: true`, the mirror image of `MaintenanceModeService`'s own safe default (`false`). There, the safe state is "not in maintenance"; here, the safe state is "provider left on," since these rows model an opt-in DISABLE, not an opt-in enable. This service must never cause the platform to silently stop sending real notifications because of a transient read failure.

## Non-Goals (Phase 1)

- Any live kill switch for STORAGE or a hypothetical PAYMENT provider (see Decision above — no safe existing degradation path for the former, no external provider at all for the latter).
- Vendor selection/switching (e.g. choosing SendGrid vs. a different email vendor at runtime) — each channel has exactly one implemented vendor (ADR-088's own disclosed picks); this stage only adds an on/off switch for the one vendor each channel already has, not a multi-vendor registry.
- Any credential storage, rotation, or masked-value display of any kind — env vars remain the only place a credential ever lives.
- Cross-instance cache invalidation for a multi-process deployment — same explicitly-deferred limitation `MaintenanceModeService` already carries (see that service's own doc comment); this codebase runs as a single Node process today.

## Implementation

- `prisma/schema.prisma` — new `enum ProviderKey { EMAIL SMS PUSH }`, new `model ProviderSetting` (one row per key, `enabled` default `true`, `reason`, `updatedAt`/`updatedById`), two new `PermissionKey` values (`PROVIDER_SETTINGS_VIEW`, `PROVIDER_SETTINGS_MANAGE`), one new `Person` reverse relation (`providerSettingsUpdatedBy`).
- `prisma/migrations/20260801160000_add_provider_settings/migration.sql` — hand-written in this sandbox in the exact shape `prisma migrate dev` itself generates (matching ADR-109's own `20260801120000_add_maintenance_feature_flags` two-new-model shape). **This sandbox cannot run `prisma migrate dev` directly against the operator's own database** — this file must be reviewed alongside the schema diff before the operator runs `prisma migrate dev` for real.
- `src/modules/provider-settings/` — new module: `provider-settings.module.ts`, `controller/provider-settings.controller.ts`, `application/provider-settings.service.ts`, `application/dto/toggle-provider-setting.dto.ts`. Same wiring template `MaintenanceModule` established (imports `BackOfficeModule`/`BackofficeRbacModule`, declares `PlatformRolesGuard` locally, exports `ProviderSettingsService`). `EmailProviderService`/`SmsProviderService`/`PushProviderService` need no explicit import — `NotificationProvidersModule` is `@Global()` (ADR-088).
- `src/app.module.ts` — registers `ProviderSettingsModule` after `DashboardModule`, before `SchedulerModule`.
- `src/modules/notifications/notifications.module.ts` — imports `ProviderSettingsModule` directly (the same "import the settings module directly for its exported service" pattern `DashboardModule` established for `MonitoringModule`), so `NotificationDispatchProcessor` can inject `ProviderSettingsService`. No cycle risk: `ProviderSettingsModule` only imports `BackOfficeModule`/`BackofficeRbacModule`, neither of which imports `NotificationsModule` back.
- `src/modules/notifications/application/notification-dispatch.processor.ts` — each of the three channel branches (`EMAIL`/`SMS`/`PUSH`) now also checks `this.providerSettings.isEnabled(<channel>)` alongside its existing `isConfigured()` check.
- `prisma/seed/rbac.seed.ts` — two new `PERMISSIONS` entries; both added to `Technical Admin`'s `ROLE_PERMISSION_MATRIX`; that role's `ROLE_DESCRIPTIONS` entry updated to mention provider settings.

## Testing

- `src/modules/provider-settings/application/provider-settings.service.spec.ts` — new file. Covers: boot defaults (every provider `true` when no rows exist, and — critically — still `true`, never throwing, if the boot-time read fails); loading real persisted per-key state; `list()`'s full three-key shape, merging DB `enabled`/`reason` with each provider's own mocked `isConfigured()`; `setEnabled` throwing `NotFoundAppError` for an unknown key without writing; the upsert call shape; the live cache updating immediately after a successful write; both audit-action names (`ProviderEnabledByAdmin`/`ProviderDisabledByAdmin`) with the correct before/after metadata.
- `src/modules/notifications/application/notification-dispatch.processor.spec.ts` — three new tests (one per channel): each configured-but-administratively-disabled provider falls back to the exact same stub path an unconfigured one already uses, and `providerSettings.isEnabled` is called with the correct channel key. All twelve pre-existing test cases' `NotificationDispatchProcessor` instantiations updated with the new constructor parameter (a `ProviderSettingsService` mock defaulting `isEnabled` to `true`, so none of ADR-088's own pre-existing coverage changes behavior).
- `test/provider-settings.e2e-spec.ts` — new file, `test/helpers/e2e-identity.ts` gains one new `PROVIDER_SETTINGS: 29` suite id. The same 401/403×2/403-no-grant/granted-live/revoked-live shape every prior stage's own e2e suite established, plus: the full three-key list shape; VIEW alone not granting PATCH; a missing-reason 400; an unknown-key 404; and a **safe, `enabled: true` no-op PATCH** (never `false`) that echoes the reason and writes the audit row — the same "never write the risky value to the real, shared row" discipline `maintenance.e2e-spec.ts`'s own top-of-file safety note established, mirrored here in the opposite direction (there the safe value is `false`; here it is `true`, since these rows model an opt-in DISABLE). A dedicated leakage-check test additionally greps the response for `accountSid`/`authToken`/`apiKey`/`privateKey` (not just the generic connection-string/stack-trace patterns every other suite's own leakage test already checks), since this endpoint's entire subject matter is provider configuration.

## Build / Unit / E2E Verification

Same situation ADR-109 was in: this stage adds a genuinely new Prisma model (`ProviderSetting`) with real delegate methods (`findMany`, `findUnique`, `upsert`), not just enum values — safely faking that surface via a hand-patched `.d.ts` was judged not worth the risk (ADR-109's own reasoning, unchanged), so no local Prisma-client hand-patch was attempted this stage.

- `npx eslint` on every new/changed file — clean (one `--fix`-only prettier pass on `csv.util.spec.ts`-equivalent formatting in the new spec files, applied).
- `npx tsc --noEmit` across the whole project: **exactly 19 errors, every single one attributable to the stale (not-yet-regenerated) Prisma Client** missing `ProviderKey`, the `providerSetting` delegate, and the two new `PermissionKey` values — the same `Property 'X' does not exist on type 'PrismaService'` / `Type '"Y"' is not assignable to type 'PermissionKey'` shape ADR-109's own 27 errors took. No other, unrelated error appeared anywhere in the project.
- `npm test`/`npm run build`/`npm run test:e2e` were **not** run in this sandbox — `ts-jest`/`nest build` both hit the identical missing-Prisma-type errors as `tsc` above and cannot execute meaningfully until the operator's own `npx prisma migrate dev`/`npx prisma generate` produce a real client.

**The operator must, in order, on their own machine:** `npx prisma migrate dev` (applies `20260801160000_add_provider_settings`), `npx prisma generate`, `npm run db:seed:rbac` (idempotent), then `npm run build`, `npm test`, `npm run test:e2e`. This ADR is not Closed until that full sequence is confirmed green (or any failure has been triaged per the roadmap's own Verification Gate — isolated rerun, root-cause, compare against ADR-107's known patterns, before attributing anything to this stage).

## Final Verification (Closure Gate)

The operator ran the real verification stack (their own Postgres/Redis) after applying this stage's changes:

- `npx prisma migrate dev` — applied `20260801160000_add_provider_settings` successfully.
- `npx prisma generate` — succeeded (overwrote the missing-type errors this sandbox's own `tsc --noEmit` run had documented, as expected).
- `npm run db:seed:rbac` — succeeded.
- `npm run build` — succeeded.
- `npm test` (full suite) — **621/621 passed, 52/52 suites** (up from 611/611, 51 suites — exactly the 10 new tests this stage added: 7 in `provider-settings.service.spec.ts`, 3 in `notification-dispatch.processor.spec.ts`).
- `npm run test:e2e` — **734/734 passed, 30/30 suites** (up from 722/722, 29 suites — exactly the 12 new tests in `test/provider-settings.e2e-spec.ts`), all green on the first real run. No transient, no isolated rerun needed, no Verification Gate triage required.

