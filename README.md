# VielHome Backend

REST API for VielHome — a mobile-first digital operating system for residential
buildings. NestJS + Prisma + PostgreSQL + Redis/BullMQ, built strictly
following the project's **AIHandoff V2** documentation (Product Philosophy,
Business Rules, Architecture, Engineering Constitution).

> This is a from-scratch rebuild of the backend, started fresh from the
> frozen AIHandoff V2 spec. It is not the old codebase.

**Status: V1.0 API contract frozen** (tag `v1.0-api-contract`, `21_ADRs >
ADR-062`; see `25_API_v1_Database_Freeze_Manifest_v1.0` for the exact,
enumerated route/schema snapshot). 79 ADRs shipped across every domain named
in the original vision docs, including real e2e test coverage for Auth
(`ADR-070`, Testing Phase 1), Building (`ADR-073`, Testing Phase 2a —
Setup Wizard, Membership Requests, Ownership Transfer, Tenancy), Finance
(`ADR-074`, Testing Phase 2b — Funds/Charge Batches, Payment lifecycle +
allocation, Adjustments, Reversal/Refund with XP clawback, Reporting),
Governance (`ADR-075`, Testing Phase 3a — Manager Verification Prerequisite,
Voting Lifecycle + Vote Target Scope, Manager Election via Vote, Meetings),
Cases (`ADR-076`, Testing Phase 3b — Creation/Listing/Visibility,
Editing, Assignment, Messaging, Status Lifecycle with `CASE_RESOLVED` XP/
achievement), Documents (`ADR-077`, Testing Phase 3c — Creation &
Category Gating, Listing/Search/Visibility, Versioning & Archive Lifecycle,
Bulk Upload, References & Download), Notifications (`ADR-078`, Testing
Phase 3d — Listing/Filtering/Category Diversity, Search, Unread-Count/Read/
Archive Lifecycle, Cross-Person Authorization, Preferences, and
NotificationTemplate Staff CRUD), and Gamification (`ADR-079`, Testing
Phase 3e — My Progress & XP History, Building Score & Cross-Building
Leaderboard, cross-domain XP via Case Resolution, staff-gated Analytics),
plus `08_API_Architecture`'s own frozen Page/Limit pagination (`ADR-072`),
implemented across BackOffice's six staff queues and Marketplace's public/
staff listings. Finance's own seven building/unit-scoped list endpoints
were a separate, later-discovered gap — closed by the Finance Hardening
Pass (post-audit; see the Finance bullet below), not part
of the original `ADR-072` rollout. That pass's own mobile-compatibility gap
(the Flutter client didn't yet read pagination metadata) is now closed too —
see `ADR-119` (Finance ↔ Mobile Pagination Contract Alignment). Other
domains' list endpoints (Building/Governance/Cases/Documents/Notifications/
Gamification) have not yet been audited against this convention — an
earlier revision of this section overstated `ADR-072` as covering "every
platform-wide unbounded listing," which this correction retracts;
platform-wide deterministic ordering, Marketplace's own pagination
migration, and a broader pagination audit remain open — tracked in
`ADR-120`. A formal Security Review and Performance
Review have both
been completed (`26_Security_Review_v1.0`, `27_Performance_Review_v1.0` —
Project docs, not ADRs). Remaining before overall MVP release readiness:
committing a versioned Swagger/OpenAPI snapshot (mechanism ready,
`ADR-071`), the remaining BackOffice and Marketplace e2e expansion work,
and the smaller named follow-ups inside each review's own Priority Order
(e.g. a real `npm audit` run, measuring the frozen numeric Performance
Targets) — see "Release readiness" below. Every sprint has been confirmed
working end-to-end by the user's own real local toolchain runs; nothing in
this repository has ever executed inside the sandboxed environment it was
written in (see "Toolchain status").

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
  management (current/history, give notice, end — `ADR-035`). Full e2e
  coverage for all four flows — `ADR-073`, Testing Phase 2a.
- **Finance** (`src/modules/finance`): immutable per-unit ledger, Charge
  Batches, Payments (report → approve/reject, self-reported by default),
  Funds, Adjustments/Refunds (`ADR-037`) with allocation against outstanding
  positive Adjustments (`ADR-053`), Collection Rate and Payment Registration
  Rate reports (`ADR-055`/`ADR-057`) — the two MVP Financial success metrics
  named in `02_MVP_Scope_v2.0`. Full e2e coverage — `ADR-074`, Testing Phase
  2b, extended by the **Finance Hardening Pass (post-audit)**: an inactive
  Fund now blocks `createChargeBatch`/`previewChargeBatch`/`createPayment`/
  `createAdjustment` (previously only `updateFund` enforced this);
  `listFunds`/`listChargeBatches`/`listUnitChargeItems`/`listUnitPayments`/
  `listUnitAdjustments`/`listPayments`/`listLedger` now use the shared
  `page`/`limit` convention (`ADR-072`) instead of returning an unbounded
  array. That pass disclosed a mobile-compatibility gap at the time (the
  Flutter client didn't yet read `metadata.pagination`, so a building/unit
  with more than `DEFAULT_PAGE_LIMIT` (20) rows would appear silently
  truncated on mobile) — **this is now closed** (`ADR-119`, Finance ↔
  Mobile Pagination Contract Alignment): `GET .../payments` gained an
  optional, validated `status` filter reusing the existing
  `(buildingId, status)` index, the mobile app gained canonical
  `PaginatedResult<T>`/`ApiClient.getPaginated<T>` primitives in
  `core/network`, and `pendingPaymentsProvider`/`fundsListProvider`/
  `UnitFinanceScreen` were all migrated to consume them — the Pending
  Payments reviewer queue (previously the highest-risk consumer of this
  gap) now filters `PENDING_APPROVAL` server-side and can no longer lose a
  still-pending payment off page 1, and Payment Detail can no longer
  misreport a genuinely-pending payment as "Already Reviewed." Confirmed
  end-to-end (773/773 e2e, `flutter analyze`/`flutter test` clean, manual
  verification against seed data exceeding the default page size) — see
  `ADR-119` for the full closure record. Finance is feature-complete for
  MVP; Marketplace's own equivalent pagination migration and
  platform-wide deterministic ordering remain deliberately deferred —
  tracked in `ADR-120`.
  Finance DTO amount fields (`ChargeBatchItemDto.amount`,
  `CreateChargeBatchDto.amountPerUnit`/`ratePerSqm`, `CreatePaymentDto.
  amount`) are now `@IsInt()` instead of `@IsNumber()`, so a decimal amount
  now 400s cleanly instead of 500ing when it hits Prisma's `Int` column.
- **Governance** (`src/modules/governance`): Votes (create/publish/close/
  cancel, ballot casting, results), multi-scope vote targeting (building/
  block/property-type/selected-units — `ADR-058`), Meetings as their own
  entity with attendance (`ADR-049`), scheduler-driven auto-publish/
  auto-close every 5 minutes (`ADR-036`). Full e2e coverage — `ADR-075`,
  Testing Phase 3a, including the real Owner Approval verification path
  and a manager-election vote electing a new VERIFIED manager end to end.
- **Cases** (`src/modules/cases`): submit/list/detail/message-thread/reopen,
  staff assign/resolve/close, duplicate-case merging (`ADR-045`), a validated
  `resolutionCode` enum (`ADR-052`). Cases Hardening Sprints C/D (`ADR-122`)
  add canonical `page`/`limit` pagination to the Case list, messages,
  assignment history, and member Support “My Cases”; prevent merge chains,
  terminal-target merges, and reopening merged Cases; preserve attributed,
  timestamped fraud evidence as append-only rows; and complete secure
  Cases↔Documents attachments. Full e2e coverage — `ADR-076`, Testing Phase
  3b.
- **Documents** (`src/modules/documents`): upload (first version)/list/
  detail/download, version history, bulk upload (`ADR-051`), expiration metadata
  (`ADR-046`),
  deterministic `page`/`limit` pagination on list/search (`ADR-072`/
  `ADR-120`); real S3/MinIO-compatible object storage (`ADR-087`) is wired
  up — a client requests a presigned PUT via `POST
  :id/documents/upload-url`, uploads directly to storage, then records the
  returned `storageKey` as `fileUrl` on the existing create/upload-version
  endpoints. **Documents Phase 1a Hardening** (post-audit) closed the
  trust boundary this originally left open: `requestUploadUrl` now
  persists a `DocumentUploadIntent` row (see the Prisma model of the same
  name) and returns its id as `uploadIntentId`; `createDocument`/
  `uploadVersion`/`bulkCreateDocuments` (per-item) now validate the
  submitted `fileUrl` against a real, unconsumed, matching intent —
  building/requester/purpose/document-binding/expiry/metadata all
  checked — issue a real presigned **HEAD Object** request to confirm the
  file actually exists in storage with the declared size, and only then
  atomically consume the intent (`consumedAt`, race-safe via a conditional
  `updateMany`) in the same transaction that writes the
  Document/DocumentVersion row. An arbitrary/unknown `fileUrl` is now
  rejected (`404`) once storage is configured. `fileUrl` is still accepted
  as opaque client-supplied metadata, with none of this validation, when
  storage isn't configured — so environments without `STORAGE_*` set see
  no regression. **Verified end-to-end** against a real MinIO + Postgres +
  Redis stack: a real presigned PUT-then-GET round trip (bytes matched), 70/70 targeted unit tests, 821/821 in the full unit suite, 3/3 targeted e2e suites (79/79 tests), the full e2e suite (32/32 suites, 802/802 tests), and a clean build — see `ADR-121`'s own "Verification status"
  for the full breakdown. Content-Type/magic-byte/file-content verification
  is still not implemented — a disclosed, permanent trust boundary (not a
  pending item), see `ADR-121`'s "Content-Type is not verified". Full e2e
  coverage — `ADR-077`, Testing Phase 3c (pre-hardening); the upload-intent
  scenarios live in `test/documents-storage.e2e-spec.ts`, and the legacy
  fixture helpers in `test/documents.e2e-spec.ts`/`test/notifications.
  e2e-spec.ts` were migrated onto the same real upload-intent flow
  (`test/helpers/create-document.ts`) so both suites pass storage-configured.
  `GET /documents/:documentId/versions` exposes the authorized, metadata-only
  version timeline newest-first using the canonical `page`/`limit` and
  `metadata.pagination` contract. It applies the same building membership and
  document visibility policy as detail/download and never includes
  object-storage URLs or credentials. Download remains the separate authorized
  `GET /document-versions/:versionId/download` operation. This backend contract
  unblocks Mobile Documents MD-05B; it does not claim the mobile Version
  History UI is implemented.
  CASE references are validated against an existing Case in the same building
  and inherit Case visibility for attachment listing, direct document detail,
  version history, and download. Dangling legacy targets fail closed; storage
  keys and presigned URLs remain confined to the existing authorized download
  response (`ADR-122`).
- **Notifications** (`src/modules/notifications`): a real, independent
  in-app (`IN_APP`) delivery channel since `ADR-027` — list/unread-count/get/
  mark-read/mark-all-read/archive/preferences — plus a real BullMQ async
  dispatch worker for non-IN_APP channels (`ADR-039`) and a staff-managed
  `NotificationTemplate` library with `{{variable}}` rendering (`ADR-060`).
  Push/Email/SMS delivery itself is still a `Logger` stub (see "Known risk
  areas") — Firebase Cloud Messaging is the named planned addition. Full e2e
  coverage — `ADR-078`, Testing Phase 3d.
- **Gamification** (`src/modules/gamification`): XP ledger + reasons,
  Achievements, Building Score + League Tier, a cross-building leaderboard
  (deliberately the one cross-tenant read in this app), XP clawback on
  payment reversal/refund (`ADR-041`), staff-only Analytics (XP Distribution,
  League Progress, Weekly Participation — `ADR-047`). Full e2e coverage —
  `ADR-079`, Testing Phase 3e. Hardened by `ADR-123` (Gamification Hardening
  Phase 1 — Integrity & Idempotency), which closed a confirmed duplicate-XP
  gap on `CASE_RESOLVED` (a Case resolved → reopened → resolved again
  previously re-earned XP/Building Score every time) with a durable DB-level
  `XpTransaction` uniqueness guarantee — the same mechanism now also backs
  the Finance clawback guard against a non-atomic double-clawback race — plus
  achievement-bonus transactional atomicity, missing-achievement-seed
  observability, `tier`/date-range query validation (clean `400`s instead of
  a silent empty list or `Invalid Date`), and dedicated unit coverage for
  `GamificationService`/`GamificationRepository`/`GamificationEventListener`/
  `XP_CATALOG`.
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
- **Backoffice Monitoring & System Health** (`ADR-108`): a new, staff-only
  `GET /api/v1/backoffice/monitoring/overview` (`PLATFORM_ADMIN` +
  `MONITORING_VIEW`, unlike the unauthenticated `/health/*` probes above) —
  Postgres connectivity + a `pg_stat_activity` activity summary, Redis
  connectivity + a limited `INFO`-derived summary, both BullMQ queues
  (`scheduled-jobs`/`notification-dispatch`) with worker-presence health,
  object-storage reachability via a real SigV4 HeadBucket check, and the
  scheduler's last successful/failed run — every check independent,
  timed-out, and aggregated into an overall `healthy`/`degraded`/`unhealthy`
  status, always returned as HTTP 200.
- **Maintenance Mode & Feature Flags** (`ADR-109`): `GET`/`PATCH
  /api/v1/backoffice/maintenance-mode` (`MAINTENANCE_MODE_VIEW`/`_MANAGE`)
  — a global maintenance toggle enforced by a request-level middleware
  that 503s all but three exempt route families (health probes, essential
  auth, the maintenance-mode endpoints themselves — the last one is the
  entire admin-lockout-prevention mechanism); and a full CRUD-minus-delete
  `GET`/`GET :key`/`POST`/`PATCH :key /api/v1/backoffice/feature-flags`
  (`FEATURE_FLAGS_VIEW`/`_MANAGE`) centralized operational feature-toggle
  registry, distinct from the customer-facing `FeatureGrant` entitlement
  model. Both mandate a `reason` on every mutation and are fully audited.
- **Backoffice Operational Dashboard** (`ADR-110`): a single, staff-only
  `GET /api/v1/backoffice/dashboard/overview` (`PLATFORM_ADMIN` +
  `DASHBOARD_VIEW`) aggregating user/building counts, building- and
  manager-verification queues (by priority), fraud/compliance/support
  triage summaries, a narrowly-scoped finance summary (pending/approved
  payment totals, refund totals, open charge batches — deliberately no
  derived "net revenue" metric), the same `MonitoringService` system-health
  overview `ADR-108` already built, and a curated allowlist of recent
  high-risk audit events. Every section is fetched independently
  (`Promise.allSettled`) with a documented fallback, so one section
  failing never turns the whole response into a 500.
- **Backoffice User Administration** (`ADR-111`): `GET
  /api/v1/backoffice/users` (paginated, `search`/`isSuspended`/
  `isBackofficeApproved` filters) and `GET /api/v1/backoffice/users/:id`
  (`USER_VIEW`) plus `POST /api/v1/backoffice/users/:id/suspend`/
  `/reinstate` (`USER_EDIT`, mandatory `reason`) — the first real routes
  either three-stage-old reserved permission key has ever had, and the
  first caller `BackOfficeRepository.reinstatePerson()` has ever had.
  Suspending a user immediately blocks their next login (`ADR-043`'s live
  `isSuspended` check); each action is audited under its own name
  (`PersonSuspendedByAdmin`/`PersonReinstatedByAdmin`), distinct from the
  Fraud Case enforcement path that can also suspend a Person.
- **Backoffice Building Administration** (`ADR-112`): `GET
  /api/v1/backoffice/buildings` (paginated, `search`/`status`/
  `hasRecoveryMode` filters) and `GET /api/v1/backoffice/buildings/:id`
  (`BUILDING_VIEW`) plus `POST /api/v1/backoffice/buildings/:id/lock`/
  `/reinstate` (`BUILDING_EDIT`, mandatory `reason`) — the first real
  routes either three-stage-old reserved permission key has ever had, and
  a third, independent caller of `BuildingRepository.updateBuildingStatus`
  alongside the Building Verification queue's decide flow and the Fraud
  Case enforcement effect. `lock`/`reinstate` set `status` to the same
  `REJECTED`/`VERIFIED` values those workflows already use, kept as the
  single source of truth for a building's standing rather than a second,
  competing flag; each action is audited under its own name
  (`BuildingLockedByAdmin`/`BuildingReinstatedByAdmin`), distinct from
  either of those two workflows' own audit trails.
- **Backoffice Financial Administration** (`ADR-113`): `GET
  /api/v1/backoffice/payments` (paginated, `search`/`status`/`buildingId`
  filters, the first payment query with no building scope required) and
  `GET /api/v1/backoffice/payments/:id` (`FINANCE_VIEW`) plus `POST
  /api/v1/backoffice/payments/:id/reverse`/`/refund` (`FINANCE_REFUND`,
  mandatory `reason`) — the first real routes either three-stage-old
  reserved permission key has ever had. Unlike User/Building
  Administration's own direct-repository-call shape, these two actions
  call the full `FinanceService.reversePayment`/`refundPayment` directly
  (a small additive `options.auditAction` parameter lets the audit trail
  still distinguish this staff-direct path — `PaymentReversedByAdmin`/
  `PaymentRefundedByAdmin` — from the in-building one), so the same real
  payer notification and Gamification score effect fire regardless of who
  initiated the reversal/refund.
- **Backoffice Notification Administration** (`ADR-114`): `GET
  /api/v1/backoffice/notifications` (paginated, `search`/`status`/`channel`/
  `category` filters) and `GET /api/v1/backoffice/notifications/:deliveryId`
  (`NOTIFICATION_DELIVERY_VIEW`) plus `POST
  /api/v1/backoffice/notifications/:deliveryId/resend` (`NOTIFICATION_
  DELIVERY_MANAGE`, mandatory `reason`) — the first genuinely new
  `PermissionKey` pair (and real migration) since ADR-110's `DASHBOARD_VIEW`,
  since no dormant `NOTIFICATION_*` pair existed to reuse. Resend resets a
  `FAILED` delivery to `PENDING` and re-enqueues the same BullMQ dispatch job
  `notify()` uses, so it goes through the exact same real Email/SMS/Push
  providers (ADR-088). Lives inside `NotificationsModule`, not
  `BackOfficeModule`, to avoid a module import cycle (`NotificationsModule`
  already imports `BackOfficeModule` for `NotificationTemplateController`'s
  own guard reuse).
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

**`npm run test:e2e` cross-suite cleanup race — investigated and closed
(`21_ADRs > ADR-107`, "E2E Cleanup Must Never Use Broad Predicates Against
Shared Seeded Fixtures").** A full parallel `npm run test:e2e` run
surfaced failures that first presented as real authorization/authentication
defects (`ManagerVerificationController`'s ADR-102 permission-migration
tests returning 403 after a permission grant; `notifications.e2e-spec.ts`'s
Notification Template permission-migration tests failing OTP verification
with 422/P2025). Both traced to test-only cleanup helpers deleting rows by
a predicate scoped only to a **shared** seeded identifier (the seeded
platform admin's `staffId` in `backoffice-rbac.e2e-spec.ts`; the seeded
staff phone numbers in `notifications.e2e-spec.ts`) — under Jest's parallel
per-file workers against one shared dev database, either predicate could
delete another concurrently-running suite's own in-flight fixture row.
Fixed by narrowing both predicates to rows the owning suite can prove are
its own (exact `roleId`; `consumedAt`/`expiresAt` state) — test code only,
no change to `PermissionsGuard`, `PermissionResolverService`, `AuthService`,
or `AuthRepository`. Re-verified clean on a full parallel run: **22/22 test
suites passed, 617/617 tests passed.** See `ADR-107` for the full root
cause, fix, and the residual-risk follow-up (auditing the same broad-
predicate shape in other files' own local cleanup helpers).

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

- **Real object storage (S3/MinIO) for Documents, and the Phase 1a
  upload-intent trust-boundary hardening — implemented and verified**:
  `ADR-087`'s hand-rolled SigV4 presigned-URL flow (`src/common/storage`)
  and `ADR-121`'s `DocumentUploadIntent` validation/atomic-consume/real
  HEAD-Object verification (`DocumentsService.resolveUploadIntent`,
  `DocumentRepository`'s `createUploadIntent`/atomic-consume,
  `StorageService.verifyObjectUploaded`) were both confirmed against a
  real MinIO + Postgres + Redis stack on the user's own machine: a real
  presigned PUT-then-GET round trip (bytes matched), the full
  `test/documents-storage.e2e-spec.ts` `STORAGE_CONFIGURED_FOR_TEST`
  scenario set (arbitrary-fileUrl rejection, pre-upload rejection,
  size-mismatch rejection, intent-reuse rejection, wrong-document-binding
  rejection, per-item bulk validation), 70/70 targeted unit tests, 821/821 in the full unit suite, 3/3 targeted e2e suites (79/79 tests), the full e2e suite (32/32 suites, 802/802 tests), and a clean build. This
  sandbox itself still cannot run any of this directly (no Docker, no
  outbound network) — the commands remain `docker-compose up -d` +
  `npm run storage:verify-roundtrip` / `npm run test:e2e` for anyone
  re-confirming it locally — but the results above are real, not sandbox
  static/unit-only claims. `test/documents.e2e-spec.ts` and `test/
  notifications.e2e-spec.ts` were migrated onto the same real upload-intent
  flow (`test/helpers/create-document.ts`, replacing both files'
  previously-duplicated, pre-`ADR-121` `createDocument` fixture) and are
  included in the 802/802 result above — no suite in this repository still
  assumes the arbitrary-`fileUrl` legacy contract when storage is
  configured.
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
- **Test coverage is policy-layer + Auth/Building/Finance/Governance/Cases/
  Documents/Notifications/Gamification e2e only**: 23 unit spec files cover
  the `domain/` policy layer across every module, plus
  `pagination.util.spec.ts` (`ADR-072`). `ADR-123` (Gamification Hardening
  Phase 1) added the first `application`/`infrastructure`-layer unit specs
  for Gamification specifically (`gamification.service.spec.ts`,
  `gamification.repository.spec.ts`,
  `gamification-event-listener.service.spec.ts`, `xp-catalog.spec.ts`) —
  every other domain's service/repository/listener layer still relies on
  e2e coverage alone, same as before. e2e coverage exists for
  `test/health.e2e-spec.ts`, `test/auth.e2e-spec.ts` (`ADR-070`, Testing
  Phase 1), `test/building.e2e-spec.ts` (`ADR-073`, Testing Phase 2a),
  `test/finance.e2e-spec.ts` (`ADR-074`, Testing Phase 2b),
  `test/governance.e2e-spec.ts` (`ADR-075`, Testing Phase 3a),
  `test/cases.e2e-spec.ts` (`ADR-076`, Testing Phase 3b),
  `test/documents.e2e-spec.ts` (`ADR-077`, Testing Phase 3c),
  `test/notifications.e2e-spec.ts` (`ADR-078`, Testing Phase 3d), and
  `test/gamification.e2e-spec.ts` (`ADR-079`, Testing Phase 3e). No
  controller-level or full-flow e2e coverage exists yet for BackOffice/
  Marketplace — a real gap for a formal QA pass, named explicitly in
  `24_Release_Readiness_Audit_v1.0` §3.4 (Testing Phase 2 and Phase
  3a/3b/3c/3d/3e now done, closing Testing Phase 3 in full — see
  `19_Current_Sprint`'s own Testing Phase numbering for what's still open
  beyond them).
- **Formal Performance Review complete (`27_Performance_Review_v1.0`)** —
  static, source-grounded review (this sandbox has never had live traffic to
  load-test). Headline finding — `08_API_Architecture`'s own frozen Page/
  Limit pagination had never been implemented anywhere — was closed by
  `ADR-072` for the review's named unbounded endpoints, plus Finance's own
  seven list endpoints separately (Finance Hardening Pass, post-audit — see
  the Finance bullet above; the mobile-compatibility gap that pass
  introduced is now also closed, `ADR-119`). Other domains' list endpoints
  have not yet been re-audited for this convention (`ADR-120`). Still open: the
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
- **Finance Hardening Pass (post-audit) — deliberately deferred, not
  overlooked**: three findings from the Finance audit were investigated and
  intentionally left unchanged this pass, rather than "fixed" speculatively.
  (1) The four sequential per-row `await` loops in `FinanceRepository`
  (oldest-due-first ChargeItem allocation on `approvePayment`, its rollback
  on `reversePayment`, `createAdjustment`'s waiver allocation, credit
  auto-apply on `issueChargeBatch`) were left as-is: each iterates a
  bounded, small set (a unit's own outstanding ChargeItems/Adjustments) and
  ordering/idempotency/transaction-semantics depend on running strictly in
  sequence inside one `$transaction` — batching them (e.g.
  `Promise.all`) would risk breaking the oldest-first allocation order for
  no measured performance benefit at this scale. (2) No trigram/GIN search
  index was added — no existing Finance list route takes a free-text search
  parameter, and no other module in this codebase uses a trigram/GIN index
  today, so there is no convention to extend and no demonstrated query this
  would speed up. (3) No amount upper bound was added to any Finance DTO —
  no canonical platform-wide "max transaction amount" convention exists
  anywhere in this codebase to apply consistently, so this is reported as a
  pending product decision rather than an invented number. See the Finance
  audit / hardening-pass report for the full reasoning behind each.
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
  Tracked as its own backlog item in `ADR-120`, alongside platform-wide
  deterministic pagination ordering, Marketplace's pagination migration, a
  broader pagination audit, and cursor pagination — all deliberately
  deferred, not overlooked.

## Release readiness

Per `24_Release_Readiness_Audit_v1.0` and `19_Current_Sprint`'s own Release
Readiness section: every named domain (all Core Product Domains plus all six
BackOffice sub-domains plus Marketplace) is shipped and confirmed working
end-to-end via the user's real local toolchain. The API + Database contract
is frozen and tagged (`ADR-062`, `v1.0-api-contract`). Both Sprint 24-named
release blockers (Git repository, migration history) are resolved (`ADR-063`)
and confirmed clean, along with the `package-lock.json` gap discovered while
building CI (`ADR-064`). Auth, Building, Finance, Governance, Cases,
Documents, Notifications, and Gamification flow e2e coverage all exist and
are confirmed working end-to-end (`ADR-070`, Testing Phase 1; `ADR-073`,
Testing Phase 2a; `ADR-074`, Testing Phase 2b; `ADR-075`, Testing Phase 3a;
`ADR-076`, Testing Phase 3b — confirmed, "سبز شد," after two round-1 fixes,
closing Testing Phase 3a+3b in full; `ADR-077`, Testing Phase 3c —
confirmed, "سبز شد," after five real-toolchain rounds, zero console errors
on the final round; `ADR-078`, Testing Phase 3d — confirmed, "سبز شد," the
cleanest first-ever run in this entire Testing-phase series, no fix round
needed; `ADR-079`, Testing Phase 3e — confirmed, "سبز شد," after one
round-1 fix for two non-fatal concurrent-deletion races, closing Testing
Phase 3 — Governance through Gamification, 3a–3e — in full). All four
originally-named Release Readiness categories — Testing, Documentation,
Performance, Security — have now been picked up at least once (`ADR-070`/
`ADR-073`/`ADR-074`/`ADR-075`/`ADR-076`/`ADR-077`/`ADR-078`/`ADR-079`;
`ADR-071`; `27_Performance_Review_v1.0`; `26_Security_Review_v1.0`), and the
Performance Review's own headline finding (frozen Page/Limit pagination
never implemented) is closed by `ADR-072` plus the Finance Hardening Pass
(post-audit) for Finance's own list endpoints; the mobile-compatibility gap
that pass introduced is now also closed (`ADR-119`, confirmed via 773/773
e2e plus a clean `flutter analyze`/`flutter test` run and manual
verification) — Finance is feature-complete for MVP. Domains outside
BackOffice/Marketplace/Finance have not yet been re-audited for the
pagination convention itself, and Marketplace's own pagination migration
plus platform-wide deterministic ordering remain deferred — tracked in
`ADR-120`. **Remaining before overall
MVP release readiness: committing a versioned Swagger/OpenAPI snapshot
(mechanism ready — `npm run docs:export-openapi`, `ADR-071`), the
remaining BackOffice and Marketplace e2e expansion work, plus the other
documented follow-up items inside each review's own Priority Order** (a
real `npm audit` run, measuring the frozen numeric Performance Targets, the
`detectAnomalies` N+1 fix, and others — see `19_Current_Sprint_v2.0`'s
Release Readiness section for the live, authoritative status).

## Next steps (per `19_Current_Sprint`)

1. Run `npm run docs:export-openapi` against the `v1.0-api-contract` tag and
   commit `docs/openapi/v1.0-api-contract.json` — the mechanism exists
   (`ADR-071`), only the actual versioned snapshot commit is still open.
2. Run a real `npm audit` (`26_Security_Review_v1.0`'s own open item — this
   sandbox has no npm registry access) and write a JWT-secret-rotation
   runbook.
3. Measure `08_API_Architecture`'s frozen numeric Performance Targets
   (`<300ms` avg, `<150ms` critical) against real traffic, and batch
   `ComplianceCaseService.detectAnomalies()`'s N+1 existence checks
   (`27_Performance_Review_v1.0` §2.1) next time that service is touched.
4. Remaining BackOffice and Marketplace e2e expansion work: several
   BackOffice sub-domains and Marketplace already have dedicated e2e
   coverage; the remaining gaps continue the pattern `test/auth.e2e-spec.ts`/`test/
   building.e2e-spec.ts`/`test/finance.e2e-spec.ts`/`test/governance.
   e2e-spec.ts`/`test/cases.e2e-spec.ts`/`test/documents.e2e-spec.ts`/
   `test/notifications.e2e-spec.ts`/`test/gamification.e2e-spec.ts`
   established — not yet scheduled. BackOffice's Manager Verification Owner
   Approval path (`06.03 Rule 002`) is fully reachable without new fixture
   work — the strongest, cheapest next candidate. BackOffice's remaining
   staff-only surface and Marketplace's moderation half both need a
   multi-actor `PlatformStaff` bootstrap solved first (see `21_ADRs >
   ADR-079`'s own Future Review).
5. ~~Real object storage (S3/MinIO) integration for Documents~~ — **DONE.**
   `ADR-087`'s presigned-upload flow and `ADR-121`'s Phase 1a upload-intent
   trust-boundary hardening (`DocumentUploadIntent`, atomic consume, real
   HEAD-Object verification) are implemented and verified against a real
   MinIO/S3 + Postgres + Redis stack on the user's own machine: a real
   PUT-then-GET round trip (bytes matched), 70/70 targeted unit tests, 821/821 in the full unit suite, 3/3 targeted e2e suites (79/79 tests), 802/802 in the full e2e suite (32/32 suites), and a clean build (see "Known risk areas"). `test/documents.e2e-spec.ts` was migrated onto the upload-intent
   flow along with `test/notifications.e2e-spec.ts` (`test/helpers/
   create-document.ts`). (Notifications' own provider-integration status is
   tracked separately and isn't re-verified as part of this update.)
6. Platform Pagination & Idempotency Hardening (`ADR-120`, backlog —
   Finance's own closure is `ADR-119` and does not block this): platform-
   wide deterministic pagination ordering, Marketplace's pagination
   migration onto the now-canonical `PaginatedResult`/`getPaginated`
   primitives, a BackOffice/Notifications pagination-consumer audit,
   cursor pagination as an open question, and a platform-wide idempotency-
   key convention. Not scheduled; each item becomes its own ADR when
   picked up.
