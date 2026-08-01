# ADR-108 — Backoffice Monitoring & System Health

**Status:** Accepted — Closed (2026-08-01)
**Context area:** 21_ADRs (Backend / Backoffice), Operational Readiness — Stage 1 of the Backoffice completion roadmap
**Related:** ADR-064 (`/health`, `/health/live`, `/health/ready` infra probes), ADR-036 (`ScheduledJobsProcessor` / first BullMQ worker), ADR-039/ADR-054/ADR-088 (Notification dispatch queue, shared queue connection, real provider dispatch), ADR-087 (Object storage / SigV4), ADR-098/ADR-099 (Backoffice RBAC Foundation, Bridge Migration), ADR-102 (Backoffice Permission Migration Completion), ADR-107 (E2E cleanup discipline)

## Context

`HealthController` (ADR-061/ADR-064) already answers three narrow infrastructure questions for load balancers and orchestrators: is the process alive (`/health/live`), should traffic be routed to it (`/health/ready`, Postgres + Redis only), and a legacy combined check (`/health`). These are deliberately unauthenticated, zero-guard, `@SkipThrottle()` probes for automated infra consumers polling frequently — not a staff-facing view.

Nothing in this codebase gives platform staff visibility into the operational state that actually matters day-to-day: is the `scheduled-jobs` queue backing up, is a BullMQ worker even connected, is object storage reachable, did the last scheduled job run succeed or fail, is Postgres under unusual connection pressure. This is Stage 1 of a 10-stage plan to bring the Backoffice module to production completeness; Monitoring was chosen first because every later stage's own health depends on being able to see whether the underlying infrastructure is functioning.

This ADR adds exactly one new endpoint and one new permission key. It does not modify `HealthController`, its routes, its contract, or its tests in any way.

## Decision — New Endpoint, Guarding, Permission

- **Route:** `GET /api/v1/backoffice/monitoring/overview`
- **Guards:** `@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)` at the controller level — the same dual-guard Bridge Migration shape (both must pass) every ADR-102 controller already uses.
- **Legacy rank:** `@PlatformRoles('PLATFORM_ADMIN')` — platform-wide operational visibility, matching Scheduler's/Legal Hold's own `PLATFORM_ADMIN`-only gating precedent.
- **Permission:** a single new key, `MONITORING_VIEW`. **No `MONITORING_MANAGE` in Phase 1** — this endpoint has no mutating action (no retry/pause/resume/clear-queue, no config write, no queue mutation), so a view-only key is sufficient, matching the `SCHEDULER_TRIGGER`/`GAMIFICATION_ANALYTICS_VIEW` precedent for a small, single-purpose domain.
- **Response code semantics:** if a snapshot can be built at all, the endpoint returns **HTTP 200** with the real aggregate status (`healthy`/`degraded`/`unhealthy`) embedded in the body — never a non-2xx for a degraded dependency. `401`/`403` follow the guards exactly as normal. `500` is reserved **only** for a failure inside this endpoint's own aggregation pipeline (a bug in `MonitoringService` itself) — a downstream dependency being down is an expected, handled case, never an unhandled exception.
- **Isolation:** every dependency check is independent, has its own timeout, and is written to never throw out of its own method. `MonitoringService.getOverview` additionally wraps every check in `Promise.allSettled` as defense in depth, so a coding mistake in one check still cannot take down the others or reject the whole response.

## Decision — Per-Dependency Design

### Database (`database`)

Connectivity is proven with the exact `SELECT 1` probe `HealthController.checkDatabase` already uses (same proven pattern, not new logic). On top of connectivity, a real Postgres activity summary is read from `pg_stat_activity`, scoped with `WHERE datname = current_database() AND usename = current_user` — only the current database and the current connecting role, never platform-wide connection data. The field is named `databaseConnections`, deliberately **not** `prismaPool` — this is a raw Postgres server-side read, not Prisma's own Metrics Preview (`previewFeatures = ["metrics"]` is not enabled anywhere in `schema.prisma`, and this ADR does not enable it). The query returns only aggregate counts (`active`/`idle`/`idleInTransaction`/`total`) — never query text, PID, or client address. If the activity query itself fails (e.g. a restricted role without `pg_stat_activity` visibility on a managed Postgres provider), connectivity is still reported from the `SELECT 1` result alone, with `databaseConnections: { metricsAvailable: false }` — an activity-query failure never downgrades the connectivity verdict. The connectivity query has its own independent timeout (2000ms) and no retry.

### Redis (`redis`)

Connectivity via `PING` on a short-lived, disposable client — the same pattern `HealthController.checkRedis` already uses (`connectTimeout`, `retryStrategy: () => null`, error-swallowed `on('error')`, `disconnect()` in `finally`). On top of connectivity, a limited summary is read from **targeted** `INFO <section>` calls (`server`, `memory`, `clients`, `replication` — never the bare `INFO` with no section, which would return everything) and only four specific fields are ever extracted by an anchored per-line regex: `uptime_in_seconds`, `used_memory`, `connected_clients`, `role`. The raw `INFO` reply text itself is never stored on the result or returned to the caller. Key count comes from `DBSIZE` — an O(1) Redis command reporting only a count — never `KEYS` or `SCAN`. No URL, password, hostname, or other connection config is ever read from any of these replies. A shared, injectable Redis client (as opposed to this per-check disposable one) was considered and rejected as a non-goal for this phase, matching `HealthController`'s own existing "low-frequency check, per-call connection overhead is acceptable" reasoning — verification did not surface any case where a shared abstraction was *required* to implement this cleanly.

### BullMQ Queues (`queues[]`)

Both of this codebase's two real queues (`scheduled-jobs`, `notification-dispatch` — confirmed via `SCHEDULED_JOBS_QUEUE`/`NOTIFICATION_DISPATCH_QUEUE`, no others exist) are reported. For each: `Queue.getJobCounts('waiting','active','delayed','completed','failed','paused')` and `Queue.isPaused()`, both already-existing BullMQ APIs — no new infrastructure. `completedSnapshot`/`failedSnapshot` are explicitly named and documented as BullMQ's **current** snapshot only (subject to this codebase's existing `removeOnComplete`/`removeOnFail` job-option pruning), never presented as permanent history.

### Worker Health (`workerHealth`)

`Queue.getWorkers()` (BullMQ's existing API, reading connected worker clients via Redis `CLIENT LIST`) is the Phase 1 signal. Semantics, deliberately conservative:

- **`available`** — at least one worker is currently connected.
- **`unhealthy`** — no worker is connected **and** there is pending work (`waiting > 0` or `delayed > 0`) that nobody is processing. This is the one case worth calling a real problem.
- **`inactive`** — no worker is connected **and** the queue is empty. In a small or dev deployment this can be entirely normal (no work to do right now), so it is deliberately **not** presented as unhealthy.
- **`unknown`** — the worker/queue lookup itself failed (e.g. Redis unreachable for BullMQ specifically), so no inference can be made either way; the queue's own `status` is `unhealthy` in this case (the fetch failed), independent of the `unknown` worker label.

A worker's presence in this list is Redis bookkeeping only — it is **not** a guarantee the worker *process* is alive and not hung on a stuck job. A dedicated worker heartbeat mechanism is an explicit Phase 1 non-goal (see Non-Goals below and Future Review).

### Storage / MinIO (`storage`)

`StorageService.isConfigured()` (pre-existing) only proves the five `storage.*` config values are set — it says nothing about reachability, which its own doc comment already disclosed as a known gap. This ADR adds `StorageService.checkBucketHealth()`, which distinguishes three separate, separately-reportable outcomes:

- **`configured`** — the server has all five `storage.*` values set.
- **`reachable`** — a real HTTP request reached the storage endpoint and got back *some* response (even a 403/404) — proves DNS/TLS/network path is alive.
- **`bucketAccessible`** — the response was exactly HTTP 200 to a HeadBucket request — the specific configured bucket exists and these credentials/policy can read it.

Implementation: a genuine SigV4-signed HTTP HEAD request against the bucket root, reusing the exact same signing path (`presignUrl`) `getPresignedUploadUrl`/`getPresignedDownloadUrl` already use — no duplicated crypto. `sigv4.ts`'s `PresignInput.method`/`buildCanonicalRequest`'s method union is widened from `'GET' | 'PUT'` to `'GET' | 'PUT' | 'HEAD'`; SigV4 itself treats the HTTP method as an opaque string in the canonical request, so this is a type-level widening only, not an algorithm change (covered by two new unit tests in `sigv4.spec.ts`). The request is issued with Node's built-in global `fetch` (Node 18+, already the project's runtime) — **zero new npm dependencies**, the same posture ADR-087 already established for this file. An independent `AbortController`-based timeout (3000ms default) is used, with no retry. Never returned, logged, or thrown: the endpoint, bucket name, access key, secret, or any response body/XML — a network failure logs only the error's `name` (e.g. `AbortError`), never its `message` (which can embed the target URL/hostname).

### Scheduler (`scheduler`)

A best-effort operational snapshot for the `scheduled-jobs` queue specifically (distinct from its own entry in `queues[]`, which only reports counts/worker health): `lastSuccessfulRun`/`lastFailedRun` are read from BullMQ's own current completed/failed job lists (`Queue.getJobs(['completed'|'failed'], 0, 0, false)`, most-recent-first), reporting only the job's `name` and `finishedOn` timestamp. **Raw `failedReason` is deliberately never read** — a failed job's error text is not returned by this endpoint at all. This is explicitly a best-effort snapshot of BullMQ's current state, not a permanent audit history — the same pruning caveat as `queues[]`'s own counts applies.

## Decision — Aggregation Semantics

Overall `status` (`healthy` | `degraded` | `unhealthy`) is computed with an explicit hard/soft dependency split:

- **Database and Redis are hard dependencies** — mirroring `/health/ready`'s own database+redis pairing, since the application genuinely cannot function without either. Either being `unhealthy` makes the whole snapshot `unhealthy`.
- **Storage, each queue, and the scheduler snapshot are soft dependencies** for this endpoint's purposes. A stalled worker or an unreachable object store is a real operational problem worth surfacing, but it does not mean the platform's core read/auth/business path is down — none of these soft sections can ever escalate the overall snapshot past `degraded`.
- If every check reports `healthy`, the overall status is `healthy`.

Every check is run independently and in parallel via `Promise.allSettled` (never a raw `Promise.all`, which would let one rejection propagate and take down the aggregation). Each check method additionally has its own internal try/catch guaranteeing it resolves rather than rejects, so the `allSettled` wrapper is defense in depth, not the only safety net.

## Implementation

New module, following the exact wiring template `SchedulerModule` already established (import `BackOfficeModule` for `PlatformRolesGuard`'s own `BackOfficeRepository` dependency, import `BackofficeRbacModule` for `PermissionsGuard`, declare `PlatformRolesGuard` as a local provider since `BackOfficeModule` does not export it, independently `BullModule.registerQueue` both queues this module needs read-only `@InjectQueue` access to — already proven safe to call from multiple modules for the same queue name, since they share one global Redis connection via `QueueConfigModule`):

- `src/modules/monitoring/monitoring.module.ts` — new module, registered in `AppModule` after `BackofficeRbacModule` (needs its exported `PermissionsGuard`), before `SchedulerModule` (no startup-ordering dependency either way — Monitoring only reads on-demand, per request, and starts nothing at boot, unlike `SchedulerBootstrapService`).
- `src/modules/monitoring/controller/monitoring.controller.ts` — the one route.
- `src/modules/monitoring/application/monitoring.service.ts` — all aggregation/check logic.
- `src/common/storage/sigv4.ts` — widened `method` union to include `'HEAD'` (additive, no behavior change to existing `GET`/`PUT` signing).
- `src/common/storage/storage.service.ts` — added `checkBucketHealth()` and the private `presignHeadBucket()` helper; no existing method changed.
- `src/app.module.ts` — one new import, one new entry in the `imports` array.

## Schema / Migration / Seed

- `prisma/schema.prisma` — one new additive `PermissionKey` enum value, `MONITORING_VIEW`, appended after `GAMIFICATION_ANALYTICS_VIEW`.
- `prisma/migrations/20260801031055_add_monitoring_view_permission/migration.sql` — `ALTER TYPE "PermissionKey" ADD VALUE 'MONITORING_VIEW';`. Additive only, matching the exact pattern every prior permission-enum migration in this repo already uses (e.g. `20260730170000_add_adr102_permissions`) — alters nothing existing, drops nothing.
- `prisma/seed/rbac.seed.ts` — added the `MONITORING_VIEW` permission definition to `PERMISSIONS`, and added it to the `Technical Admin` role in `ROLE_PERMISSION_MATRIX` (the natural home alongside that role's other platform-wide operational keys: `SYSTEM_SETTINGS`, `FEATURE_FLAGS`, `SCHEDULER_TRIGGER`, `GAMIFICATION_ANALYTICS_VIEW`). `Super Admin` gains it automatically (`PERMISSIONS.map((p) => p.key)`). No other role changed.

## Testing

- `src/common/storage/sigv4.spec.ts` — two new tests proving the widened `method` union signs a `HEAD` request correctly and produces a different signature than `GET` for the same path.
- `src/common/storage/storage.service.spec.ts` — new `checkBucketHealth` describe block: not-configured short-circuits with no network call; 200 response → `reachable: true, bucketAccessible: true`; non-200 (403) → `reachable: true, bucketAccessible: false`; a thrown/rejected fetch → both `false`; and a check that the secret access key never appears in the signed URL beyond the signature itself.
- `src/modules/monitoring/application/monitoring.service.spec.ts` — new file. Fully mocks Prisma, `ioredis`, `StorageService`, and both `Queue` objects to exercise the aggregation contract itself: a fully-healthy snapshot; database-down → overall `unhealthy` without affecting other independent sections; a `pg_stat_activity` failure that only degrades `metricsAvailable`, never connectivity; Redis-down → overall `unhealthy`; a check that no raw Redis `INFO` text, host, or port ever appears in the serialized response; storage not-configured / bucket-inaccessible → `degraded`, never escalating overall status past `degraded`; queue `workerHealth` for all three of `available`/`unhealthy`/`inactive`, and the explicit assertion that an `unhealthy` **queue** only degrades the **overall** status (queues are soft dependencies); scheduler `lastSuccessfulRun`/`lastFailedRun` reporting with an explicit assertion that a job's `failedReason` text never appears anywhere in the response; and that `getOverview()` never rejects even when a check throws synchronously mid-pipeline.
- `test/monitoring.e2e-spec.ts` — new file, new `E2E_SUITE_ID.MONITORING = 22` entry in `test/helpers/e2e-identity.ts`. Covers: 401 unauthenticated; 403 plain non-staff; 403 `REVIEWER` (rank 1, below required `PLATFORM_ADMIN`); 403 for a `PLATFORM_ADMIN`-ranked staff member holding a disposable role with **no** `MONITORING_VIEW` grant (proves `PermissionsGuard` enforces independently of the legacy rank check, the same live-grant/revoke pattern ADR-102's own Scheduler e2e block established); granting `MONITORING_VIEW` opens the route immediately (live, uncached) and returns a well-shaped `200` body (status enum values, ISO `checkedAt`, both queues present by name, worker-health enum values, scheduler `lastSuccessfulRun`/`lastFailedRun` keys present); a dedicated no-leakage test asserting the serialized response never matches raw Redis `INFO` markers, a Postgres connection-string shape, a stack-trace-shaped line, `failedReason`, or a `"pid"` key; and revoking the grant closes the route again immediately.

## Build / Unit / E2E Verification

This sandbox cannot reach the user's local Postgres/Redis/BullMQ stack (established repeatedly earlier in this same engagement), so `npm run build`, `npm test`, and `npm run test:e2e` were run by the user on their own machine after applying this stage's changes. See the accompanying closure report (delivered in the same turn as this ADR) for the actual command output and pass/fail counts — this document is not backfilled with results it did not itself produce.

Before running these, the operator must additionally run, once: `npx prisma migrate dev` (or `deploy`) to apply the new migration, `npx prisma generate` to regenerate the Prisma Client's `PermissionKey` type (needed for `@RequiresPermission('MONITORING_VIEW')` to type-check and for the seed script to accept the new key), and `npm run db:seed:rbac` (idempotent — safe to re-run) to grant `MONITORING_VIEW` to `Technical Admin`/`Super Admin`.

## Final Verification (Closure Gate)

The operator ran the real verification stack (their own Postgres/Redis,
not this engagement's sandbox, which cannot reach either) after applying
this stage's changes:

- `npx prisma migrate dev` — applied `20260801031055_add_monitoring_view_permission` successfully.
- `npx prisma generate` — succeeded.
- `npm run db:seed:rbac` — succeeded: 31/31 permissions, 8/8 roles, 2 new
  `RolePermission` grants this run (`MONITORING_VIEW` for `Technical Admin`
  and `Super Admin`).
- `npm run build` — succeeded.
- `npm test` — succeeded (50 unit tests across `sigv4.spec.ts`,
  `storage.service.spec.ts`, `monitoring.service.spec.ts` and the
  pre-existing suite).
- `npm run test:e2e` — three full runs across this closure cycle:
  - **Run 1:** `test/monitoring.e2e-spec.ts` failed with
    `PrismaClientKnownRequestError: notifications_recipientId_fkey` in
    its own `deleteOncePerPhoneBatch` teardown — a real, deterministic
    bug in this stage's own new test file (missing
    notification/gamification FK-chain deletes before `Person`), fixed
    in commit `a88c12c`. `test/building.e2e-spec.ts` also failed once in
    this run (`verifyOtp` 404-vs-200), self-resolving on an immediate
    rerun with zero code changes.
  - **Run 2** (after `a88c12c`): `test/monitoring.e2e-spec.ts` passed.
    `test/building-verification.e2e-spec.ts` failed (13 tests, one
    cascading `otp/request` 404-vs-200 root cause).
  - **Run 3:** all 23 suites passed, 624/624 tests, including
    `test/monitoring.e2e-spec.ts`, `test/building.e2e-spec.ts`, and
    `test/building-verification.e2e-spec.ts`.
  - The `building.e2e-spec.ts` and `building-verification.e2e-spec.ts`
    transients were investigated and, on the strength of full-suite
    scope analysis and clean full-suite reruns, recorded as two further
    instances of ADR-107's "Isolated, unreproducible HTTP-status
    transients" — see that ADR's 2026-08-01 addendum. Neither ADR-108
    commit touches auth, OTP, or either of those two test files.

ADR-108 is CLOSED on this basis: the one real defect found
(`monitoring.e2e-spec.ts`'s own teardown) was fixed and verified; the two
unrelated transients were triaged, scoped out, and cross-referenced
rather than assumed away.

## Non-Goals (Phase 1)

Explicitly out of scope for this ADR, listed exhaustively:

- Any change to `/health`, `/health/live`, `/health/ready` (route, contract, guards, or tests).
- HTTP 503 (or any non-200) readiness-style semantics for the new endpoint.
- Prometheus / OpenMetrics export.
- PagerDuty / Opsgenie / any external alerting integration.
- Distributed tracing.
- Health-history persistence (this endpoint is always a live, point-in-time snapshot).
- A dedicated worker heartbeat mechanism (see Future Review).
- Any queue mutation: retry, pause, resume, or clear.
- Prisma Metrics Preview (`previewFeatures = ["metrics"]` is not enabled).
- Rate-limiting of this endpoint beyond the app's existing global `ThrottlerGuard`.
- A Monitoring UI or Dashboard UI (Stage 3 of the broader roadmap, not this ADR).
- `MONITORING_MANAGE` or any mutating monitoring action.

## Consequences

- Positive: platform staff gain the first real, staff-only operational-telemetry endpoint in this codebase, covering every piece of infrastructure this backend depends on (Postgres, Redis, both BullMQ queues, worker presence, object storage, the scheduler) in one call, with every dependency checked independently and in parallel.
- Positive: zero new npm dependencies (`fetch` is a Node built-in; `ioredis`/`bullmq`/`@prisma/client` are all pre-existing dependencies already used the same way elsewhere in this codebase).
- Positive: `sigv4.ts`'s widened method union is reusable by any future feature needing a signed `HEAD`/`GET`/`PUT` request, at zero cost to existing callers.
- Neutral: `/health/*` and their existing consumers are completely unaffected — this is a strictly additive, parallel layer.
- Residual, tracked for later (see Future Review): no dedicated worker heartbeat; no health-history persistence; no external alerting; a Monitoring UI is a separate, later stage.

## Future Review

- **Worker heartbeat:** `Queue.getWorkers()` proves Redis-level worker *presence*, not that the worker process is alive and making progress on its current job. A dedicated heartbeat (e.g. the worker periodically writing its own liveness timestamp) would close this gap and let `workerHealth` distinguish "connected and healthy" from "connected but hung." Not built in Phase 1 — flagged here for a follow-up ADR if operational experience shows this distinction is needed in practice.
- **Health history:** this endpoint is always a live snapshot. If staff need to see *trends* (e.g. "was the queue backed up an hour ago too?"), that requires persisting snapshots over time — explicitly deferred to Stage 10 (Analytics) of the broader roadmap, and only with real accumulated history, never a fabricated or point-in-time value presented as historical.
- **`MONITORING_MANAGE`:** if a future phase adds any mutating action to this domain (queue retry/pause/resume/clear, for instance), it should get its own `MONITORING_MANAGE` key rather than overloading `MONITORING_VIEW` — consistent with this codebase's `<DOMAIN>_VIEW`/`<DOMAIN>_MANAGE` convention for domains large enough to need the split.
- **Shared injectable Redis client:** both this ADR and ADR-064 (`HealthController`) each open their own short-lived Redis connection per check. If per-call connection overhead ever becomes a real cost (unlikely at current polling frequencies), a shared, injectable Redis client could replace both call sites — not needed today.
