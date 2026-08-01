# ADR-118 — Initial Backoffice Bootstrap

**Status:** Proposed — pending the operator's real build/unit/e2e verification run
**Context area:** 21_ADRs (Backend / Backoffice), operational/deployment tooling — a follow-on ADR after the 10-stage Backoffice completion roadmap (Stages 1-10, ADR-108 through ADR-117, all Closed), not itself part of that roadmap's stage numbering
**Related:** ADR-099 (Backoffice RBAC Foundation — the "deterministic seed creates no `StaffRole` rows for real staff" decision this ADR's whole premise rests on), ADR-098 (Bridge Migration architecture — `RbacManagementController`'s own "bootstrap problem, deliberately resolved this way" doc comment, unresolved until now), ADR-107 (e2e cleanup discipline — this ADR's e2e suite follows its "never write a risky/irreversible value against a real shared row" precaution)

## Context

The 10-stage Backoffice completion roadmap is fully closed. While reviewing the completed system, one intentional architectural gap was identified: there is no supported way to create the very first real Technical Admin (or any other RBAC role holder). This is not a bug — it is the direct, correct consequence of two deliberate prior decisions:

- `prisma/seed/rbac.seed.ts` (ADR-099) seeds the full permission catalog, all six roles (including `'Technical Admin'`), and every `RolePermission` grant — but creates **zero** `StaffRole` rows. Its own schema comment states this explicitly: *"real staff are deliberately not auto-assigned into the new roles by this ADR"* — the correct security default (auto-assigning a real, arbitrary person to the platform's highest-privilege RBAC role from a seed script would be far worse).
- `RbacManagementService.assignRole(staffId, roleId, actorPersonId, requestId?)` requires a real, non-null acting `Person` for every grant — its own doc comment: *"REQUIRES a real acting Person — unlike the deterministic seed ..., which is the only place a null actor / `SYSTEM_SEED` source is valid."* `RbacManagementController` is gated by the legacy `PlatformRolesGuard` + `@PlatformRoles('PLATFORM_ADMIN')` specifically because *"these endpoints cannot be gated by the NEW permission system — nobody holds any permission through it yet"* (its own doc comment, verbatim). This is the exact chicken-and-egg problem: granting the first RBAC role requires an already-privileged actor, and none exists.

Today, the only way to get a working `PLATFORM_ADMIN` account at all is `prisma/seed.ts`'s hardcoded "Dev Tester" (`+989120000000`) — a dev/test fixture used across every e2e suite in this codebase, never intended as a real production administrator identity, and it holds no RBAC role/permission at all (only the legacy `PlatformStaffRole` rank).

A real-repo-state investigation (redoing an initial pass that had mistakenly used a stale local repository mirror frozen at ADR-107, before this gap could even be confirmed against current code) confirmed:

- `AuthService.verifyOtp` creates a `Person` via `AuthRepository.createPerson(phone)` — phone only, no other fields set at creation (`fullName`/`email` stay null); this is the exact same minimal shape every real customer registration produces.
- No application-layer code anywhere creates a `PlatformStaff` row except `prisma/seed.ts`'s own two `upsert` calls — `grep -rn "platformStaff\.(create|upsert)" src/` returns zero matches.
- `scripts/` already holds three precedented standalone operational scripts (`export-openapi.ts`, `verify-storage-roundtrip.ts`, `verify-notification-providers.ts`), all invoked via `ts-node` from a `package.json` script, all using a hand-rolled `loadDotEnv()` (not the `dotenv` package, which is only a transitive, undeclared dependency), all with **no NestJS application bootstrap** — the natural home and convention for this new script.
- `$transaction`-wrapped repository methods elsewhere in this codebase (e.g. `FinanceRepository.createFund`) always write direct `tx.<model>.*` calls inline, never re-wrap another injected repository against the transaction client — the established convention this ADR's own transactional repository method follows.

## Decision — A New Script, `npm run bootstrap:backoffice`, Not an HTTP Endpoint

`scripts/bootstrap-backoffice-admin.ts`, wired via a new `bootstrap:backoffice` `package.json` script entry. Deliberately **no HTTP route of any kind**. Exposing "create the first `PLATFORM_ADMIN`" over HTTP would itself need to be gated by an already-existing `PLATFORM_ADMIN` — the exact same chicken-and-egg problem this feature exists to solve — or worse, would need to be deliberately left unauthenticated/self-authenticating, which is a real privilege-escalation surface no matter how it's dressed up. An operator-invoked, server-local script has no such exposure.

## Decision — Idempotent by Construction: Check the Role, Not the Phone

`BootstrapBackofficeAdminService.run()` first resolves the target `Role` by name (`'Technical Admin'` by default) and checks whether **any** active (`revokedAt: null`) `StaffRole` already grants it to anyone. If so, it returns `{ status: 'ALREADY_EXISTS', admin: <the existing holder's info> }` and makes **no writes of any kind** — deliberately without ever requiring, validating, or even reading a phone number in that branch, exactly per the stated requirement ("If one exists: exit successfully without modifying anything"). Only when no active holder exists does it require and validate a phone number. This makes the script safe to wire into every deploy, unconditionally, forever — it is a true no-op once a real admin exists.

## Decision — Reuse the Existing Architecture, Extend Where a Genuine Gap Exists

- **Phone validation**: reuses `normalizeIranianMobilePhone`/`isValidIranianMobilePhone` (`src/common/phone/phone.util.ts`) — the same normalization boundary every phone-accepting DTO in this codebase already uses. No second phone-parsing implementation.
- **Role lookup by name**: `BackofficeRbacRepository` gained one new method, `getRoleByName(name)` — a trivial, safe addition (`Role.name` is `@unique`) filling a genuine, narrow gap (the repository already has `getRoleById` but nothing that resolves the well-known `'Technical Admin'` name, since no prior stage ever needed to look up a role by its human name rather than its generated `cuid()` id).
- **Person/PlatformStaff/StaffRole/AuditLog writes**: a new, dedicated `BackofficeBootstrapRepository.createBootstrapAdmin(...)` wraps the whole find-or-create-Person → upsert-`PlatformStaff` → create-`StaffRole` → two-`AuditLog`-entries sequence in one `$transaction`, following `FinanceRepository`'s own established transactional-repository convention exactly (direct `tx.<model>.*` calls inline — not a re-wrap of `AuthRepository`/`BackofficeRbacRepository`/`AuditService` against the transaction client, since that is not how this codebase's own existing transactional repositories are built). The reuse here is of the established **conventions** (exact `PlatformStaff` upsert shape from `prisma/seed.ts`; exact `'StaffRoleAssigned'` audit action name and shape from `RbacManagementService.assignRole`; exact null-actor + `metadata.source` tagging convention from `rbac.seed.ts`'s own `auditSeedCreate` helper, renamed `'SYSTEM_BOOTSTRAP'` here to distinguish a real, idempotent, potentially-production bootstrap run from a deterministic-seed-time-only `'SYSTEM_SEED'` write), not a literal call-through of the other repositories' methods — bypassing `RbacManagementService.assignRole` itself is deliberate and necessary, for the identical reason `rbac.seed.ts` already bypasses it: no real acting Person exists yet to satisfy its required, non-null `actorPersonId`.
- **No parallel Person-creation path**: a brand-new Person is created via the same minimal, phone-only shape `AuthRepository.createPerson`/real OTP registration already produces (a friendly `fullName` is then set only for a genuinely new Person — see below) — never a richer, bootstrap-specific Person shape that could drift from what real registration produces.
- **Existing Person reuse**: if a Person with the target phone already exists (a real user who separately signed up, or an existing but under-ranked `PlatformStaff`), that exact row is reused and promoted (its `fullName` is left untouched — the bootstrap's own default display name is never silently overwritten onto a real person's existing name) rather than a second, phone-colliding Person ever being attempted (`Person.phone` is `@unique`, so this reuse-first design is also the only way to avoid a hard failure on that constraint).
- **Suspended-person guard**: if the phone resolves to an existing, `isSuspended: true` Person, the script refuses with a `ConflictError` rather than silently granting the platform's highest privilege to a suspended account.

## Decision — Both the Legacy Rank and the New RBAC Role

Creating (or promoting) the `PlatformStaff` row sets the legacy `PlatformStaffRole` to `PLATFORM_ADMIN` (the highest legacy rank) **in addition to** granting the RBAC `'Technical Admin'` `StaffRole` — both are required for the account to actually work, since every route this whole roadmap built is dual-gated (`PlatformRolesGuard` legacy floor + `PermissionsGuard` new RBAC check), per ADR-098's Bridge Migration design. Granting only the RBAC role without the legacy rank would 403 on every single Backoffice route regardless of permissions held.

## Decision — Audit Trail

Two `AuditLog` entries are written per successful bootstrap, both with `actorId: null` and `metadata.source: 'SYSTEM_BOOTSTRAP'` (mirroring `rbac.seed.ts`'s own null-actor convention, distinctly tagged so a real bootstrap run is never confused with the deterministic seed's own `'SYSTEM_SEED'`-tagged rows in a later audit search):

- `'PlatformStaffBootstrapped'` (new action; entityType `'PlatformStaff'`) — `metadata: { personId, phone, wasNewPerson, source }`.
- `'StaffRoleAssigned'` (reused, unchanged action name/shape — the exact same one `RbacManagementService.assignRole` already writes for an API-driven grant, and the exact one already on `DashboardService`'s own `CRITICAL_AUDIT_ACTIONS` allowlist, ADR-110) — `metadata: { staffId, roleId, roleName, source }`.

`'PlatformStaffBootstrapped'` is deliberately **not** added to `DashboardService.CRITICAL_AUDIT_ACTIONS` in this ADR, even though it is arguably exactly the kind of rare, security-sensitive event that allowlist exists for — per the explicit instruction not to modify ADR-108–117 behavior. Left as a Future Review candidate.

## Non-Goals

- **No HTTP endpoint** of any kind for this capability (see Decision above) — this is intentionally CLI-only, forever.
- **No credential of any kind is created or returned.** `Person` has no password field at all in this codebase (phone + OTP is the only authentication mechanism) — there is nothing analogous to an initial-password concern here.
- **No multi-admin bootstrap, no bulk import.** This creates exactly one admin, once. Adding further Technical Admins (or any other role holder) after the first is the real `POST /api/v1/backoffice/rbac/staff/:staffId/roles` endpoint's job (`RbacManagementController`), unchanged by this ADR.
- **No changes to `RbacManagementService`/`RbacManagementController`'s own actor-required enforcement** — this ADR adds a second, narrowly-scoped, non-HTTP way to grant a `StaffRole` for exactly this one bootstrap scenario; it does not loosen the real API's own requirement for a real actor.
- **No changes to any ADR-108–117 file's behavior** (`dashboard.service.ts`'s `CRITICAL_AUDIT_ACTIONS` included, per the explicit instruction above).
- **No new Prisma model, enum value, or migration.** Every table this ADR writes to (`Person`, `PlatformStaff`, `StaffRole`, `AuditLog`) already exists; the lightest possible schema footprint of any ADR in this project so far — genuinely zero schema change.

## Implementation

- `src/modules/backoffice-rbac/infrastructure/repositories/backoffice-rbac.repository.ts` — added `getRoleByName(name: string)`.
- `src/modules/backoffice-bootstrap/infrastructure/repositories/backoffice-bootstrap.repository.ts` — new `BackofficeBootstrapRepository`: `findActiveGrantsForRole(roleId)`, `createBootstrapAdmin({ roleId, roleName, phone, fullName })` (the `$transaction`-wrapped write sequence).
- `src/modules/backoffice-bootstrap/application/bootstrap-backoffice-admin.service.ts` — new `BootstrapBackofficeAdminService.run(options)`, the idempotency/validation orchestration described above. Exports `DEFAULT_BOOTSTRAP_ROLE_NAME` (`'Technical Admin'`) and `DEFAULT_BOOTSTRAP_ADMIN_NAME` (`'Backoffice Administrator'`).
- `src/modules/backoffice-bootstrap/backoffice-bootstrap.module.ts` — new module, no controller, re-declares `BackofficeRbacRepository` as a local provider (same "re-declare the class as a local provider in more than one module" pattern `BackofficeRbacModule` itself already established for `BackOfficeRepository`).
- `src/app.module.ts` — registers `BackofficeBootstrapModule` (last, after `AnalyticsModule`) — purely so the service is reachable through Nest's DI container for the e2e suite; the CLI script itself never boots Nest.
- `scripts/bootstrap-backoffice-admin.ts` — new standalone script, manual construction (no `NestFactory`, matching every other script in `scripts/`), reads `BOOTSTRAP_ADMIN_PHONE`/`BOOTSTRAP_ADMIN_FULL_NAME` from `.env` (via the same hand-rolled `loadDotEnv()` every other script already uses) or `--phone`/`--full-name` CLI args (CLI takes precedence), prints a friendly result, exits 0 on success (both branches) or 1 on any error.
- `package.json` — new `"bootstrap:backoffice": "ts-node scripts/bootstrap-backoffice-admin.ts"` entry, alongside `db:seed`/`db:seed:rbac`.

## Testing

- `bootstrap-backoffice-admin.service.spec.ts` (7 tests, fully mocked repositories) — role-not-found; already-exists short-circuit (no phone read, `createBootstrapAdmin` never called); missing-phone validation error when no admin exists yet; invalid-phone validation error; phone normalization + default display name; custom display name trimmed; custom role name honored end-to-end.
- `test/bootstrap-backoffice-admin.e2e-spec.ts` (6 tests, against the real dev database via `app.get(BootstrapBackofficeAdminService)`) — role-not-found; full happy path (creates Person+PlatformStaff+StaffRole+2 audit rows, then proves the account is genuinely functional via a real OTP login followed by a real `GET /api/v1/backoffice/dashboard/overview` call using the newly-granted permission); idempotency (second call with a different phone returns the identical existing admin, touches nothing, writes no new audit rows, the second phone's Person is never created); missing-phone validation when none exists yet; existing-person reuse (no duplicate Person row, pre-existing `fullName` preserved); suspended-person guard.

**Safety note, mirroring ADR-107 discipline**: this suite deliberately never bootstraps the real `'Technical Admin'` role name — `npm run test:e2e` runs every suite concurrently against one shared dev database, and this service's entire contract is "the first active holder wins, permanently." Every test creates its own uniquely-named throwaway `Role` instead, passed explicitly via `roleName`, cleaned up (along with its `RolePermission` grants, and every `Person`/`PlatformStaff`/`StaffRole` row created) in `afterAll` — the identical precaution `maintenance.e2e-spec.ts`/`provider-settings.e2e-spec.ts` already established for their own irreversible-shared-state hazards.

## Build / Unit / E2E Verification

Unlike ADR-116/ADR-117, this stage introduces **zero** Prisma schema changes — no new model, no new enum value — so, uniquely among the more recent stages, the full verification sequence could be run directly in-sandbox: `npx eslint --fix` clean on every touched file; `npx tsc --noEmit` across the whole project: **zero errors**; `npm run build`: succeeded; `npm test`: **636/636 passed, 54 suites** (up from 629/629, 53 suites — the +7 delta is exactly the 7 new tests in `bootstrap-backoffice-admin.service.spec.ts`). `npm run test:e2e` was not run in-sandbox — the full e2e run takes roughly 50 seconds on the operator's machine, past this sandbox's hard 45-second command ceiling — the operator is asked to run it directly.

## Consequences

- Positive: closes a real, previously-undocumented operational gap — every environment (fresh dev machine, staging, production) now has a safe, supported, idempotent way to provision its first administrator, with no manual `INSERT` and no direct SQL anywhere.
- Positive: zero schema footprint — the lightest-weight ADR in this project's history alongside ADR-115.
- Positive: the created account is provably identical in shape to a real customer registration (same `AuthRepository`-shaped `Person` row) plus the same `PlatformStaff`/`StaffRole` shape any real, API-driven grant would produce — no bootstrap-only data shape exists anywhere that a real admin account wouldn't also have.
- Neutral: the script only ever bootstraps `Role`s that already exist in the seed catalog (by design — it extends the existing RBAC model, it never invents a new one) — an environment that has not yet run `npm run db:seed:rbac` gets a clear, actionable `NotFoundAppError` rather than any attempt to self-heal by creating the role itself.

## Future Review

- **`CRITICAL_AUDIT_ACTIONS` (`dashboard.service.ts`, ADR-110)**: `'PlatformStaffBootstrapped'` is a strong candidate for that allowlist — deliberately not added in this ADR per the explicit "do not modify ADR-108–117 behavior" instruction.
- **Multi-environment safety rail**: nothing today prevents `npm run bootstrap:backoffice` from being run against a production database with `BOOTSTRAP_ADMIN_PHONE` pointed at the wrong number — a future `NODE_ENV`-aware confirmation prompt (or a required `--force-production` flag when `NODE_ENV=production`) could reduce that operator-error risk, not built here since the current requirement was silent on it.
