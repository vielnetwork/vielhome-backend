# Object backup foundation — PROD-REL-07I1D

Source/schema implementation only; Production runner activation and verified
real-storage recovery remain separate release gates. Important Production files remain gated until
isolated integration and synthetic recovery verification succeed.

## Baseline and scope

Based on recorded Production baseline 354063f4d1cab8e6bbc3d160084be87cd977e59d.
Reconfirm the live deployment before a later deployment review. Documents,
new versions, bulk document finalization, and payment receipts are included.
Advertising is deferred. Document archival preserves versions and evidence;
invalid unfinalized receipt cleanup still does not enqueue a backup.

`DocumentRepository` creates requests within the existing business transaction.
The source bucket comes from the normal `STORAGE_BUCKET` configuration. Legacy
non-storage development without that value keeps its old behavior. No backup
credential is required by the API. Deploy the additive migration before code
that finalizes stored files; do not deploy this code against an unmigrated DB.

## Runner contract

Only the standalone runner accepts the following variables. It never loads
`.env`, falls back to `DATABASE_URL`, or bootstraps `AppModule`.

| Variable                             | Meaning                                              |
| ------------------------------------ | ---------------------------------------------------- |
| BACKUP_ENV                           | `production` or `test`                               |
| BACKUP_DATABASE_URL                  | Dedicated least-privilege database role connection   |
| BACKUP_SOURCE_ENDPOINT               | HTTPS S3 endpoint, no path/query/userinfo            |
| BACKUP_SOURCE_BUCKET                 | `vielhome-production` in Production                  |
| BACKUP_SOURCE_ACCESS_KEY_ID          | Independent source reader, never API identity        |
| BACKUP_SOURCE_SECRET_ACCESS_KEY      | Source reader secret                                 |
| BACKUP_DESTINATION_ENDPOINT          | HTTPS S3 endpoint, no path/query/userinfo            |
| BACKUP_DESTINATION_BUCKET            | `vielhome-production-backup` in Production           |
| BACKUP_DESTINATION_ACCESS_KEY_ID     | Independent destination writer                       |
| BACKUP_DESTINATION_SECRET_ACCESS_KEY | Destination writer secret                            |
| BACKUP_MAX_BYTES                     | Optional byte ceiling; default/max 67108864 (64 MiB) |

Production endpoints are restricted to account
89ba5a789e2a1c732adc790b622e1995.r2.cloudflarestorage.com. Test buckets must start
with `test-`; test DB must use localhost/127.0.0.1. HTTP is permitted only for
loopback test storage. No real credentials belong in tests.

Different source/destination keys and secrets are mandatory. If normal
`STORAGE_ACCESS_KEY_ID` or `STORAGE_SECRET_ACCESS_KEY` is present, equality is
rejected. This detects accidental equality only; it cannot prove IAM scope or
identity when normal credentials are absent. Never inject normal application
credentials merely to perform this comparison. Scope/denied-access verification
is a separately authorized operational check.

Source adapter exposes HEAD/GET only. Destination exposes GET and conditional
PUT only, never DELETE. Bucket-scoped source read-only and destination read/write
credentials must be held by an independent runner, not the normal API. Database
role requires SELECT on document_versions, SELECT/UPDATE on object_backup_requests,
and SELECT/INSERT/UPDATE on object_backup_generations; it needs no business-table writes, DELETE, or DDL. Ordinary API
role needs INSERT on backup requests. Grant changes are out of scope.

## Commands and scheduling (not deployed)

After build:

- `npm run backup:run`: one bounded batch, maximum 100 requests; stops claiming
  after four minutes, but completes the current bounded transfer.
- `npm run backup:reconcile`: read-only paginated reconciliation, no repair.
- `npm run backup:metrics`: aggregate coverage without listing private identifiers.

Future schedule: run batch every five minutes, reconciliation daily. Provision
scheduler/runner/secrets separately. Ten-minute per-request leases permit crash
recovery. Claims are conditional database updates; completion is fenced by owner
and unexpired lease in a transaction. Storage requests time out at 30 seconds.
Automatic failure retries use 30/60/120/240/300-second delays, capped at ten
attempts for ordinary retryable states. Expired COPYING is recoverable even after
repeated process crashes. Exhausted FAILED/SOURCE_MISSING records remain visible;
manual retry is a separate reviewed DB action, not automatic deletion or reset.

The 15-minute RPO is a target, not a guarantee from a five-minute schedule.
Backlog, unsupported/oversized files, provider failures, exhausted attempts, and
missing source objects require operator attention. Capacity and schedule testing
must establish throughput before real important files are accepted. In-memory
buffers are bounded per download at 64 MiB; allow headroom for source/verification
buffers or lower the ceiling. Multipart and disk-spooled large files are deferred.

## Integrity and retention

HEAD -> conditional GET -> HEAD checks source identity and size. SHA-256 is
computed from bytes; ETag is a concurrency marker, not a content checksum.
Each attempt persists a UUID capture with unique destination and manifest keys:

- `objects/v1/<request-id>/<capture-id>`
- `manifests/v1/<request-id>/<capture-id>.json`

PUT uses `If-None-Match: *`. Read-back verifies bytes by SHA-256, then writes and
reads back the private manifest. Only then are generation metadata and VERIFIED
state committed together. An expired lease cannot mark the request verified.
Failed attempts may leave retained objects/metadata; retries use new captures.
No automatic cleanup, overwrite, or deletion synchronization exists.

Manifest v1 contains environment, source bucket/key/size/ETag/last-modified,
opaque reference type/id, SHA-256, destination bucket/key, capture ID, backup
and verification timestamps. It contains no content, original filename field,
credentials, signed URLs, or authorization headers. Source keys may include
historical filenames: manifests are private recovery data, not public telemetry.
The manifest describes verified bytes; DB state can still lag after a crash.

Backup bucket 30-day age lock is managed outside this source. It protects age
from creation, not time since primary deletion. Retained copies must remain
while business/history references need them; no expiration is implemented.
No foreign key to business rows can cascade-delete recovery evidence. Generation
request FK is ON DELETE RESTRICT. RETIRED/retiredAt are reserved metadata;
no automatic retirement/garbage collection is implemented.

## Reconciliation and monitoring

Reconciliation scans all document versions (including receipts/archived versions)
in pages of 100. Reports missing requests/key mismatches, overdue objects,
VERIFIED requests without complete generation metadata, conflicting verified
checksums, missing source objects before verified protection, and failed source
checks. It never repairs state or deletes data. Unique DB constraints prevent
repeated capture IDs/keys; different hashes for one reference are conflicts.
Provider HEAD checks are only for versions without valid recorded protection;
periodic re-hashing of already verified backup objects is deferred.

Staff-only monitoring overview gains optional `objectBackup` when normal storage
is configured: unprotectedCount, oldestUnprotectedAgeSeconds, failedCount,
overdueCount. SQL includes finalized versions with no requests. More than 900
seconds is overdue. Query failure is `{available:false}`, never healthy zero.
Existing aggregate health/public liveness/readiness behavior is unchanged.
No alert integration is created; future monitoring must explicitly inspect this
section and fail unavailable signals safely.

## Operational controls — PROD-REL-07I1F-R1

No Production activation, shared migration, secrets, or external monitoring is
provided by this change. No schema or migration change is needed.

### Mode-specific configuration and exits

All modes require BACKUP_ENV, BACKUP_DATABASE_URL and BACKUP_SOURCE_BUCKET.
Metrics requires no R2 endpoint or credentials. Reconcile additionally requires
only BACKUP_SOURCE_ENDPOINT, BACKUP_SOURCE_ACCESS_KEY_ID and
BACKUP_SOURCE_SECRET_ACCESS_KEY. Run requires both source and destination
configuration from the table above. Never inject destination credentials into
metrics/reconcile or backup credentials into the API.

Exit 0 means computed healthy/idle completion. Exit 1 means computed unhealthy
state (including processing failures or reconciliation discrepancies). Exit 2
means invalid configuration, unavailable computation, execution/disconnect
failure, or interruption. No failure automatically repairs or deletes state.
Run evaluates queue health after processing, so an idle exhausted queue is not
reported as healthy. Metrics evaluates both queue-wide and document coverage.

Queue-wide aggregates include total, pending, copying, unprotected, FAILED,
SOURCE_MISSING, exhausted ordinary retries, active/expired/invalid leases,
valid/invalid VERIFIED, overdue, and oldest unprotected age. They include
synthetic and non-document requests within the configured source bucket.
Protection requires complete verified generation metadata and consistent hashes.
Missing/inconsistent metadata remains unprotected. RETIRED is reserved and is
not treated as proof of protection. Any failure/missing/exhausted/expired/invalid
state or age strictly greater than 900 seconds is unhealthy. Active work below
that threshold alone is not unhealthy. No private identifiers appear in metrics.

### Execution and heartbeat

Every pooled DB connection receives statement_timeout=10000ms,
lock_timeout=3000ms, idle_in_transaction_session_timeout=15000ms;
connect/pool timeout=5s and connection_limit=2. Existing URL `options` are
replaced with these controlled startup parameters. Verification transactions
also have maxWait=3s and timeout=15s. Deployment must verify role/connection
compatibility rather than weakening these limits.

Run performs at most 100 sequential claims and stops new claims after four
minutes. All modes have an eight-minute process deadline. SIGTERM/SIGINT stops
new claims and reconciliation iteration, allowing at most 30 seconds of grace.
Forced termination exits 2; leases remain recoverable. An in-flight verification
still requires an unexpired lease/owner and a generation belonging to its request.
Only verified storage can be committed VERIFIED; interruption does not manufacture
success. Existing ten-minute leases and retry limits remain unchanged. A blocked
runtime can still be killed by the external scheduler; missing completion must
therefore be detected independently.

JSON events have schemaVersion=1, runId, mode and timestamp. `backup.started`
precedes work; `backup.completed` includes durationMs, exitCode, outcome
(healthy/unhealthy), and sanitized aggregate summary after disconnect.
`backup.terminated` records forced termination. Never parse raw exception text or
log connection strings, credentials, filenames, object keys, or signed URLs.
A future wrapper must pair start/completion by runId and require BOTH exit 0 and
healthy completion. Nonzero, missing completion, missing scheduled start, timeout,
and crash must not count as healthy heartbeats. Provision independent missed-run
monitoring in a later phase; stdout alone cannot detect a runner that never starts.

### Important-upload activation gate

API flag `VH_IMPORTANT_UPLOADS_BLOCKED`: unset or exactly `false` preserves
existing behavior. `true` and every other explicitly supplied value fail closed
with HTTP 503. The flag guards document upload authorization, initial/bulk/version
finalization, receipt upload intent/finalization, and repository write boundaries
inside the existing transactions. Downloads and normal non-upload APIs remain
available. Existing data is not changed; finalization and backup request creation
remain atomic when open.

Before accepting important Production files, set the flag to `true` on every API
instance through a separately authorized rollout; drain old instances/in-flight
requests. This is a process-environment gate, not a live distributed switch.
Previously issued presigned URLs cannot be revoked by this flag and might create
unfinalized objects, but finalization is blocked. Only explicitly reopen after
runner, permissions, monitoring, synthetic restore and RPO evidence pass. There
is no automatic health-based flag flip and no environment is changed here.

### RPO and next-phase activation contract

Queue metrics expose measuredProtectionCount, maxProtectionLatencySeconds and
lateVerifiedCount using first valid verifiedAt minus finalizedAt, plus current
oldest-unprotected age and overdue count. Historical late completion is retained
as an informational counter, not a permanent unhealthy status after protection.
A five-minute schedule does not establish the <=15-minute RPO.

Proposed later schedules: run every five minutes, metrics every minute,
reconcile daily. Independently monitor missed/failed runs. Use a runner with a
verified provider network path and isolated least-privilege identities. Measure
synthetic finalization-to-verification across scheduled cycles, backlog, bounded
failures and recovery; record latency and alert delivery before opening the gate.
Capacity tests must cover maximum accepted upload size. The 64MiB ceiling is per
object, not total process memory; budget for multiple buffers or lower the limit.
Scheduler resources, DB grants, secrets and alert destinations remain unprovisioned.

## Verification and release gates

Source verification includes the full Jest suite (Finance/Documents/backup),
mode/exit/heartbeat/gate/termination tests and a disposable PostgreSQL 16 test.
The isolated test applies existing migration history only and verifies real DB
timeouts, queue age boundaries, metadata/latency, metrics CLI without R2 secrets,
verification fencing/transaction rollback, and gated document finalization.
Storage in these tests is fake in-memory storage. This proves neither real R2
permissions/retention nor Production throughput, scheduling or restored recovery.

Run the standalone isolated test only with
BACKUP_OPERATIONAL_TEST_DATABASE_URL pointing to localhost database
`vielhome_prod_rel_07i1fr1`, after building and applying existing migrations.
The script rejects other database targets. It creates/removes synthetic fixtures.
No dependency, Prisma schema or migration change belongs to this operational fix.
Production activation remains separately gated on safe runner provisioning,
least-privilege DB grants, real provider permission/lock/restore verification,
independent alerts, closed-gate rollout and measured protection latency.
