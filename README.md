# VielHome Backend

REST API for VielHome — a mobile-first digital operating system for residential
buildings. NestJS + Prisma + PostgreSQL + Redis/BullMQ, built strictly
following the project's **AIHandoff V2** documentation (Product Philosophy,
Business Rules, Architecture, Engineering Constitution).

> This is a from-scratch rebuild of the backend, started fresh from the
> frozen AIHandoff V2 spec. It is not the old codebase.

**Status: V1.0 API contract frozen** (tag `v1.0-api-contract`, `21_ADRs >
ADR-062`; see `25_API_v1_Database_Freeze_Manifest_v1.0` for the exact,
enumerated route/schema snapshot). 72 ADRs shipped across every domain named
in the original vision docs, including the first real e2e test coverage
(`ADR-070`, Auth flow) and `08_API_Architecture`'s own frozen Page/Limit
pagination, implemented for the first time across every platform-wide
unbounded listing (`ADR-072`). A formal Security Review and Performance
Review have both been completed (`26_Security_Review_v1.0`,
`27_Performance_Review_v1.0` — Project docs, not ADRs). Remaining before
overall MVP release readiness: broader Testing coverage (Phase 2+),
committing a versioned Swagger/OpenAPI snapshot (mechanism ready,
`ADR-071`), and the smaller named follow-ups inside each review's own
Priority Order (e.g. a real `npm audit` run, measuring the frozen numeric
Performance Targets) — see "Release readiness" below. Every sprint has
been confirmed working end-to-end by the user's own real local toolchain
runs; nothing in this repository has ever executed inside the sandboxed
environment it was written in (see "Toolchain status").

## What's implemented so far

Organized by domain, each with its own `21_ADRs` entry for full rationale —
this section is a map, not a replacement for those.

- **Cross-cutting infrastructure**: standard API response envelope, error
  taxonomy (`ValidationError`, `AuthorizationError`, `NotFound`, `Conflict`,
  `BusinessRuleViolation`, `Duplicate`, `RateLimit`, `UnexpectedError`),
  RequestId propagation, structured audit logging (`AuditLog`, append-only),
  a domain-event pipeline, `helmet` security headers, global `ThrottlerGuard`
  (`ADR-061`), locked-down CORS (`ADR-061`), structured JSON logging in
  production (`ADR-064`), a shared `page`/`limit` pagination utility
  (`src/common/pagination`, `ADR-072`) implementing `08_API_Architecture`'s
  own frozen Pagination contract.
- **Foundation / Auth** (`src/modules/foundation/auth`): OTP-based login
  (`request` → `verify`), JWT access + refresh tokens (rotated, single-use),
  device registration ("Remember Device"), `Person.isSuspended` enforced live
  on every request via `JwtStrategy` (`ADR-043`).
- **Building** (`src/modules/building`): resumable Building Setup Wizard with
  Draft/Auto-Save/Resume (Zero Data Loss), building creation with founding
  Owner/Manager membership and automatic skeleton unit generation, Unit
  management (create/list/update, unique-per-building enforcement),
  postal-code duplicate-building prevention with a Membership Request escape
  hatch (list/approve/reject, now including the requester's `person` relation
  — `ADR-069`), owner invites with phone-based auto-link on OTP verify,
  Ownership Transfer (self-service, phone-based — `ADR-035`) and Tenancy
  management (current/history, give notice, end — `ADR-035`).
- **Finance** (`src/modules/finance`): immutable per-unit ledger, Charge
  Batches, Payments (report → approve/reject, self-reported by default),
  Funds, Adjustments/Refunds (`ADR-037`) with allocation against outstanding
  positive Adjustments (`ADR-053`), Collection Rate and Payment Registration
  Rate reports (`ADR-055`/`ADR-057`) — the two MVP Financial success metrics
  named in `02_MVP_Scope_v2.0`.
- **Governance** (`src/modules/governance`): Votes (create/publish/close/
  cancel, ballot casting, results), multi-scope vote targeting (building/
  block/property-type/selected-units — `ADR-058`), Meetings as their own
  entity with attendance (`ADR-049`), scheduler-driven auto-publish/
  auto-close every 5 minutes (`ADR-036`).
- **Cases** (`src/modules/cases`): submit/list/detail/message-thread/reopen,
  staff assign/resolve/close, duplicate-case merging (`ADR-045`), a validated
  `resolutionCode` enum (`ADR-052`).
- **Documents** (`src/modules/documents`): upload (first version)/list/
  detail/download, bulk upload (`ADR-051`), expiration metadata (`ADR-046`);
  `fileUrl` is client-supplied metadata only — no real object storage backend
  exists yet (see "Known risk areas").
- **Notifications** (`src/modules/notifications`): a real, independent
  in-app (`IN_APP`) delivery channel since `ADR-027` — list/unread-count/get/
  mark-read/mark-all-read/archive/preferences — plus a real BullMQ async
  dispatch worker for non-IN_APP channels (`ADR-039`) and a staff-managed
  `NotificationTemplate` library with `{{variable}}` rendering (`ADR-060`).
  Push/Email/SMS delivery itself is still a `Logger` stub (see "Known risk
  areas") — Firebase Cloud Messaging is the named planned addition.
- **Gamification** (`src/modules/gamification`): XP ledger + reasons,
  Achievements, Building Score + League Tier, a cross-building leaderboard
  (deliberately the one cross-tenant read in this app), XP clawback on
  payment reversal/refund (`ADR-041`), staff-only Analytics (XP Distribution,
  League Progress, Weekly Participation — `ADR-047`).
- **BackOffice** (`src/modules/backoffice`) — all six named sub-domains
  shipped: Manager Verification (approve/reject/suspend/restore — `ADR-029`/
  `ADR-040`), Building Verification + appeals, Fraud & Abuse Center (case
  review, per-severity-escalated Enforcement Actions — `ADR-031`/`ADR-044`,
  metrics — `ADR-050`), Support & Operations Center (case review, metrics —
  `ADR-032`/`ADR-048`), Subscription Management (plan/status/trial/
  grace-period/feature-grant state, reports — `ADR-033`), Audit & Compliance
  Center (Compliance Cases, Timeline, CSV Export, Legal Hold, Dashboard
  Metrics — `ADR-034`). Subscription's `evaluateExpiry` and Compliance's
  `detectAnomalies` both run on a real daily BullMQ cadence (`ADR-036`). All
  six staff queues now support `page`/`limit` pagination (`ADR-072`).
- **Marketplace** (`src/modules/marketplace`): a moderated service-provider
  directory (submit/list/detail, staff approve/reject — `ADR-030`), no
  transactional capability (booking/payment/commission) — deliberately
  excluded, confirmed staying in V1.0 as a moderated directory via an
  explicit Sprint 24 product decision. Both the public browse listing and
  the staff moderation queue now support `page`/`limit` pagination
  (`ADR-072`).
- **Scheduler** (`src/modules/scheduler`, `ADR-036`): this codebase's first
  real BullMQ worker — daily Subscription expiry evaluation, daily Compliance
  anomaly detection, 5-minute Voting auto-publish/auto-close — plus a
  `PLATFORM_ADMIN`-only manual trigger endpoint for ops testing.
- **Health / Observability / CI** (`ADR-064`): `GET /health` (legacy),
  `GET /health/live` (liveness), `GET /health/ready` (readiness — Postgres +
  Redis checks in parallel); a GitHub Actions CI pipeline
  (`.github/workflows/ci.yml`) running lint/test/e2e/build on every push
  against real Postgres + Redis service containers.
- **Git / Migrations** (`ADR-063`): a real Git repository, tagged
  `v1.0-api-contract`; `prisma/migrations/0_baseline_v1_freeze/` — a real,
  committed baseline migration (the user's own local run against a real dev
  database, since this sandbox has never had one).

Everything on `02_MVP_Scope_v2.0`'s "Excluded From MVP" list (AI Assistant
Foundation, real transactional Marketplace, Enterprise Edition, IoT, Advanced
AI) is intentionally not built — confirmed clean via direct grep, not
assumption (`24_Release_Readiness_Audit_v1.0` §1.3).

## Toolchain status

This backend was originally scaffolded inside a sandboxed cloud workspace
with **no access to npm/package registries or a live database**, so no code
in this repository has ever executed inside that sandbox itself. Every
sprint since has instead been verified by the user's own real local
toolchain (`npm install`/`npm run lint:ci`/`npm test`/`npm run test:e2e`/
`npm run build`), with results and any fixes fully recorded in `21_ADRs`'s
per-ADR "Post-Delivery Verification" subsections. As of this writing: Git
repository real and tagged (`ADR-063`), `prisma/migrations/` real and
committed (`ADR-063`), `package-lock.json` real and committed (`ADR-064`),
`npm run lint:ci`/`npm run test:e2e`/`npm run build` all confirmed clean,
`npm test` passing 23/23 suites (265/265 tests) as of the `ADR-062` freeze
pass. Treat any *new* delivery's first local run as its own real first test
pass regardless of this history — see "Known risk areas."

## Prerequisites

- Node.js 20+ and npm
- Docker (for local Postgres + Redis) — or point `DATABASE_URL`/`REDIS_HOST`
  at your own instances

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
docker-compose up -d

# 3. Configure environment
cp .env.example .env
# edit .env if you changed any docker-compose ports/credentials

# 4. Apply the committed migration history (ADR-063's baseline + everything
#    since). If this is a genuinely fresh database:
npx prisma migrate deploy
# If you're upgrading an existing dev database that predates ADR-063's
# baseline and gets a drift error, this is pre-launch dev data — the
# simplest fix is to reset instead:
#   npx prisma migrate reset
# (drops the dev database, reapplies all migrations from scratch — do not
# run this against anything you care about keeping)

# 5. (optional) seed a dev user
npm run db:seed

# 6. Run the API in watch mode
npm run start:dev
```

The API listens on `http://localhost:3000/api/v1`.
Swagger docs: `http://localhost:3000/docs` (live/auto-generated). To publish
a versioned, diffable snapshot alongside a release tag instead (`21_ADRs >
ADR-071`), run `npm run docs:export-openapi` — writes
`docs/openapi/v1.0-api-contract.json`, which should then be committed. See
"Release readiness" below.

## Trying the auth flow

```bash
# 1. Request an OTP (in dev, the code is printed to the server console —
#    no SMS gateway is wired up yet)
curl -X POST http://localhost:3000/api/v1/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone": "+989120000000"}'

# 2. Verify it (copy the code from the server log)
curl -X POST http://localhost:3000/api/v1/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone": "+989120000000", "code": "12345", "deviceToken": "dev-device-1", "platform": "web"}'

# -> returns { data: { accessToken, refreshToken, personId, isNewPerson, hasBuildings } }

# 3. Start the Building Setup Wizard (use accessToken from step 2)
curl -X POST http://localhost:3000/api/v1/buildings/setup/draft \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"step": "role_selection", "payload": {"role": "OWNER"}}'

curl -X POST http://localhost:3000/api/v1/buildings/setup/draft \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"step": "review", "payload": {"name": "Vista Tower", "totalUnits": 12, "buildingType": "RESIDENTIAL", "country": "IR", "city": "Tehran", "district": "Saadat Abad", "mainStreet": "Sarv", "plateNumber": "12", "postalCode": "1998877665"}}'

curl -X POST http://localhost:3000/api/v1/buildings/setup/submit \
  -H "Authorization: Bearer <accessToken>"
```

## Project structure

Follows `11_Backend_Architecture` (Domain-Driven Design) and
`09_Engineering_Constitution` (Feature-First, layered):

```
src/
  common/           cross-cutting: prisma, audit, errors, filters,
                    interceptors, middleware, guards, decorators, events,
                    logging (ADR-064), queue (shared BullMQ config, ADR-054)
  config/           typed configuration loader
  modules/
    foundation/
      auth/         controller / application / domain / infrastructure / events
      identity/     (Person — Prisma model + Auth usage)
    building/       Setup Wizard, Units, Membership Requests, Ownership
                    Transfer, Tenancy (ADR-021, ADR-035, ADR-069)
    finance/        Ledger, Charge Batches, Payments, Funds, Adjustments,
                    Collection/Payment Registration Rate reports
    governance/     Votes, Meetings, scoped targeting
    cases/          Cases, message threads, merging
    documents/      Documents, versions, bulk upload, expiration metadata
    notifications/  in-app channel, async dispatch worker, templates,
                    preferences
    gamification/   XP, Achievements, Building Score, League, leaderboard,
                    analytics
    backoffice/     Manager/Building Verification, Fraud & Abuse, Support &
                    Operations, Subscription, Audit & Compliance — 6
                    sub-domains, each own controller/application/domain/
                    infrastructure
    marketplace/    moderated service-provider directory
    scheduler/      BullMQ worker (expiry, anomaly detection, auto-publish/
                    close) + manual trigger endpoint
    health/         liveness/readiness
prisma/
  schema.prisma     60 models, 60 enums — every domain above
  migrations/       0_baseline_v1_freeze/ (ADR-063) — real, committed history
```

Each feature module keeps the same shape: **controllers are thin**, business
rules live in `domain/`, orchestration in `application/`, persistence in
`infrastructure/`. Never add business logic to a controller or a repository
— see `09_Engineering_Constitution.md` in the project's AIHandoff docs.

## Known risk areas (things to double-check before/at first production use)

- **Real object storage (S3/MinIO) for Documents — still open**:
  `DocumentVersion.fileUrl` accepts client-supplied metadata only, no actual
  file transfer happens. Needs a new npm dependency this sandbox has never
  been able to install/verify, plus a provider-abstraction decision no
  source doc specifies.
- **Real Push/Email/SMS provider for Notifications — still open**: every
  non-IN_APP delivery is a `Logger` stub, always recorded as `SENT`, never
  actually `DELIVERED`. Firebase Cloud Messaging is the named planned
  addition (`ADR-027`/`ADR-039`). This is also why OTP codes and owner/
  tenant invites are still console-logged only, not texted.
- **Swagger/OpenAPI versioned publish — mechanism ready, snapshot not yet
  committed**: `21_ADRs > ADR-071` adds `npm run docs:export-openapi`
  (`scripts/export-openapi.ts`), which writes the exact document `/docs`
  serves live to `docs/openapi/<tag>.json` for git history to track. Needs
  a live `DATABASE_URL`/`REDIS_HOST` to run (same as `npm run test:e2e`) —
  run it once against the `v1.0-api-contract` tag and commit the result to
  actually close `24_Release_Readiness_Audit_v1.0` §3.5.
- **Test coverage is policy-layer + Auth e2e only**: 23 unit spec files cover
  the `domain/` policy layer across every module, plus `pagination.util.
  spec.ts` (`ADR-072`); e2e coverage exists for `test/health.e2e-spec.ts` and
  `test/auth.e2e-spec.ts` (`ADR-070`, Testing Phase 1). No controller-level
  or full-flow e2e coverage exists yet for Finance/Governance/Cases/
  Documents/Notifications/Gamification/BackOffice/Marketplace — a real gap
  for a formal QA pass, named explicitly in `24_Release_Readiness_Audit_v1.0`
  §3.4 (Testing Phase 2+).
- **Formal Performance Review complete (`27_Performance_Review_v1.0`)** —
  static, source-grounded review (this sandbox has never had live traffic to
  load-test). Headline finding — `08_API_Architecture`'s own frozen Page/
  Limit pagination had never been implemented anywhere — is now closed by
  `ADR-072` for the review's named unbounded endpoints. Still open: the
  frozen numeric Performance Targets (`<300ms` avg, `<150ms` critical) have
  never actually been measured against real traffic; a low-urgency N+1
  pattern in `ComplianceCaseService.detectAnomalies()`; no application-level
  caching anywhere; unconfigured BullMQ worker concurrency.
- **Formal Security Review complete (`26_Security_Review_v1.0`)** — direct
  source-grounded audit across Authentication/Session Management,
  Authorization/IDOR, Injection, Data Exposure, and Dependency Posture (Snyk
  lookups against pinned major packages). One finding mitigated (an explicit
  warning comment on the OTP `console.log`, since no other OTP-delivery
  mechanism exists yet). Still open: a real `npm audit` run (this sandbox has
  no npm registry access), a JWT-secret-rotation runbook.
- **Reputation, Daily Missions, Seasonal Events (Gamification) — not
  built**: each was researched and found too weakly-sourced (no formula, no
  weights, no thresholds anywhere in the source docs) to build without
  inventing product logic — see `21_ADRs` → ADR-028/036/037 Future Review
  for the full comparison research.
- **Recovery Mode auto-expiry, Cases/Support SLA breach tracking — not
  wired**: the scheduler infrastructure exists (`ADR-036`), but neither has
  a numeric threshold specified anywhere in the source docs — the real
  blocker is a missing business-rule decision, not missing infrastructure.
- **`class-validator` phone validation**: `@IsPhoneNumber(undefined)` accepts
  any region — confirm this is permissive enough for your target markets, or
  pin it to specific country codes.
- **JWT/refresh token durations**: `parseDurationMs` in `auth.service.ts` is
  a minimal hand-rolled parser (`15m`, `30d`, etc.) — swap for a library like
  `ms` if you need broader format support.
- **No idempotency-key convention**: relevant to any future client-side
  offline-retry work (the mobile app's `SyncOutboxItems` pattern, `21_ADRs >
  ADR-065`) — a retried POST against a non-naturally-idempotent endpoint can
  double-apply if it "succeeded" server-side but the response was lost.

## Release readiness

Per `24_Release_Readiness_Audit_v1.0` and `19_Current_Sprint`'s own Release
Readiness section: every named domain (all Core Product Domains plus all six
BackOffice sub-domains plus Marketplace) is shipped and confirmed working
end-to-end via the user's real local toolchain. The API + Database contract
is frozen and tagged (`ADR-062`, `v1.0-api-contract`). Both Sprint 24-named
release blockers (Git repository, migration history) are resolved (`ADR-063`)
and confirmed clean, along with the `package-lock.json` gap discovered while
building CI (`ADR-064`). Auth flow e2e coverage now exists and is confirmed
working end-to-end (`ADR-070`, Testing Phase 1). All four originally-named
Release Readiness categories — Testing, Documentation, Performance, Security
— have now been picked up at least once (`ADR-070`; `ADR-071`;
`27_Performance_Review_v1.0`; `26_Security_Review_v1.0`), and the
Performance Review's own headline finding (frozen Page/Limit pagination
never implemented) is now closed by `ADR-072`. **Remaining before overall
MVP release readiness: Testing Phase 2+ (Building/Finance e2e coverage and
beyond), committing a versioned Swagger/OpenAPI snapshot (mechanism ready —
`npm run docs:export-openapi`, `ADR-071`), and the smaller named follow-ups
inside each review's own Priority Order** (a real `npm audit` run, measuring
the frozen numeric Performance Targets, the `detectAnomalies` N+1 fix, and
others — see `19_Current_Sprint_v2.0`'s Release Readiness section for the
live, authoritative status).

## Next steps (per `19_Current_Sprint`)

1. Testing Phase 2 — Building (Setup Wizard, Membership Requests, Ownership
   Transfer, Tenancy) and Finance (payment report → approve, ledger
   correctness) e2e coverage, continuing the pattern `test/auth.e2e-spec.ts`
   established.
2. Run `npm run docs:export-openapi` against the `v1.0-api-contract` tag and
   commit `docs/openapi/v1.0-api-contract.json` — the mechanism exists
   (`ADR-071`), only the actual versioned snapshot commit is still open.
3. Run a real `npm audit` (`26_Security_Review_v1.0`'s own open item — this
   sandbox has no npm registry access) and write a JWT-secret-rotation
   runbook.
4. Measure `08_API_Architecture`'s frozen numeric Performance Targets
   (`<300ms` avg, `<150ms` critical) against real traffic, and batch
   `ComplianceCaseService.detectAnomalies()`'s N+1 existence checks
   (`27_Performance_Review_v1.0` §2.1) next time that service is touched.
5. Real object storage (S3/MinIO) integration for Documents, and a real
   Push/Email/SMS provider (Firebase Cloud Messaging) for Notifications —
   both need a new npm dependency and a provider decision this sandbox
   cannot make unilaterally.
