# Object backup foundation — PROD-REL-07I1D

Source/schema only. No runner, secrets, shared migration, R2 traffic, or restore
has been deployed/executed. Important Production files remain gated until
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

| Variable | Meaning |
| --- | --- |
| BACKUP_ENV | `production` or `test` |
| BACKUP_DATABASE_URL | Dedicated least-privilege database role connection |
| BACKUP_SOURCE_ENDPOINT | HTTPS S3 endpoint, no path/query/userinfo |
| BACKUP_SOURCE_BUCKET | `vielhome-production` in Production |
| BACKUP_SOURCE_ACCESS_KEY_ID | Independent source reader, never API identity |
| BACKUP_SOURCE_SECRET_ACCESS_KEY | Source reader secret |
| BACKUP_DESTINATION_ENDPOINT | HTTPS S3 endpoint, no path/query/userinfo |
| BACKUP_DESTINATION_BUCKET | `vielhome-production-backup` in Production |
| BACKUP_DESTINATION_ACCESS_KEY_ID | Independent destination writer |
| BACKUP_DESTINATION_SECRET_ACCESS_KEY | Destination writer secret |
| BACKUP_MAX_BYTES | Optional byte ceiling; default/max 67108864 (64 MiB) |

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
role requires SELECT on document_versions and SELECT/INSERT/UPDATE on the two
backup tables; it needs no business-table writes, DELETE, or DDL. Ordinary API
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

## Verification and release gates

Source tests use synthetic bytes and mock transport only. Transaction test doubles
explicitly model commit/rollback but do not prove PostgreSQL isolation. Local
Docker daemon was unavailable during implementation: actual migration/constraint,
concurrent claims, and role permissions remain next-phase checks. Never run this
runner with Production variables during source verification.

Required next phase: isolated PostgreSQL migration and concurrency checks,
runner-role verification, local synthetic storage compatibility, failure and
backlog tests. 07I2/07I2B are not executed by this change. Runtime denied-access,
R2 lock enforcement and a real synthetic restore need separate authorization.

The backup implementation adds no dependencies. Under 07I1D-R1, approved security
commit 9014df1911ccd2e87db1858051d2aba3956c2a0e was cherry-picked without conflicts
as 25a84a7c9c7d4f3bda86519571f1dd43f28c2a03 onto baseline
354063f4d1cab8e6bbc3d160084be87cd977e59d. Its dependency declarations and lockfile
are unchanged; backup implementation remains a separate commit.

Runtime npm audit before/after: critical 0/0, high 5/0, moderate 9/9, low 1/1.
The dependency gate passes. npm ci, Prisma generation/format/validation, build,
and npm ls pass. Backup/document/receipt/monitoring, storage/signing, bootstrap,
and mocked health regression coverage totals 269 tests across 17 suites.
The local HTTP health tests require permission to bind an ephemeral test socket;
all database/Redis dependencies in that suite are mocked. No migration was applied.

Migration review: additive enum and two tables, seven indexes, and a generation
to request foreign key with ON DELETE RESTRICT. ON UPDATE CASCADE only maintains
that new-table relationship; there is no business-row cascade or existing-record
mutation. SQL is compatible with PostgreSQL 16 by inspection; real PostgreSQL
migration, constraints, concurrency, and runner-role verification remain pending.

Conditional request compatibility reference (read 2026-09-08):
https://developers.cloudflare.com/r2/api/s3/api/
