# ADR-121 — Documents Upload-Intent Trust-Boundary Hardening (Phase 1a)

**Status:** Implemented and verified — real MinIO round-trip (PUT + GET, bytes matched), 70/70 targeted unit tests, 821/821 in the full unit suite, 3/3 targeted e2e suites (79/79 tests), 32/32 full e2e suites (802/802 tests), and a clean build, all confirmed against a real MinIO/S3 + Postgres + Redis stack on the user's own machine. See Verification status below.
**Context area:** Documents (`src/modules/documents`), Storage (`src/common/storage`)
**Related:** ADR-087 (real S3/MinIO-compatible object storage for Documents — the presigned-upload flow this ADR closes a gap in); ADR-072/ADR-120 (the deterministic-pagination hardening delivered in the same Phase 1a pass, tracked separately in `document.repository.ts`'s own comments)

## Context

An implementation audit of the Documents module (conducted before this pass) flagged a real, confirmed security gap in the ADR-087 upload flow: `createDocument`/`uploadVersion`/`bulkCreateDocuments` accepted any client-supplied `fileUrl` string as a storage key, with no proof the caller had ever been issued a presigned upload URL for it, and no proof the caller had actually uploaded anything to that key. A client could call these endpoints directly with a fabricated `fileUrl` and have it recorded as a Document's storage key — the metadata row would exist, but the object it claimed to point to might never have been uploaded, might belong to a different building, or might have been uploaded by a different caller entirely.

The audit was explicit that none of the following count as evidence this actually worked: presigned URL generation succeeding, database metadata being written, or a unit test passing with a mocked storage client. All three were already true before this pass and none of them proved the trust boundary was closed.

## Decision

Add a database-backed `DocumentUploadIntent` model (migration `20260806095431_add_document_upload_intent`) that `requestUploadUrl` persists the moment a presigned PUT is issued. `createDocument`/`uploadVersion`/`bulkCreateDocuments` (per item) now validate the submitted `fileUrl` against a real, matching, unconsumed intent before trusting it, and issue a real presigned **HEAD Object** request against storage to confirm the object actually exists with the declared size — only then is the intent atomically consumed (via a conditional `updateMany` on `consumedAt IS NULL`, race-safe against concurrent requests) in the same short transaction that writes the Document/DocumentVersion row.

### Why a signed token was rejected as an alternative

A simpler alternative considered (and explicitly rejected) was a signed, stateless token instead of a database row — e.g. a JWT encoding the storage key, building, requester, and expiry, verified by signature alone with no DB lookup. This was rejected because a stateless token cannot be *consumed*: nothing prevents the same valid, unexpired token from being replayed to create multiple Documents from a single presigned upload, and revocation (e.g. an admin invalidating a specific pending upload) is not possible without also maintaining server-side state — at which point the token adds complexity without removing the database dependency it was meant to avoid.

### Validation fields and consumption idiom

`DocumentUploadIntent.consumedAt` is a nullable `DateTime`, not a `Boolean` — the same idiom this schema already uses for `OtpRequest.consumedAt`/`RefreshToken.revokedAt`/`Device`'s session fields. Every field submitted at create/upload-version time is checked against the intent: `buildingId`, `requestedById`, `purpose` (`CREATE_DOCUMENT` vs `CREATE_VERSION`), `documentId` (for `CREATE_VERSION` only — binds the intent to one specific Document), `fileName`/`fileType`/`fileSize`, and `expiresAt`.

### Sequencing: why the storage network call sits outside the transaction

The instructions this pass was scoped against were explicit: storage network calls must never sit inside a long-running Prisma transaction (a transaction holds a connection, and depending on isolation level, locks, for its full duration — a HEAD request over the network has no reason to be inside that window). The implemented sequence is:

1. Look up and validate the intent (fast, DB-only, no transaction yet).
2. Issue the real presigned HEAD Object request (network I/O, no transaction open).
3. Only if both pass, open a short DB transaction that atomically consumes the intent and writes the Document/DocumentVersion row.

**Disclosed race window:** between step 2 and step 3, a second concurrent request could consume the same intent first. This is not silently unhandled — the conditional `updateMany` in step 3 means at most one of two racing requests' transactions can actually succeed; the loser receives `ConflictError` (409), not a silently-wrong success. Fully closing this window would require holding the intent locked (e.g. `SELECT ... FOR UPDATE`) across the storage network call itself — exactly the long-transaction-blocked-on-network-I/O pattern this pass was scoped to avoid. This is a disclosed, accepted trade-off, not an oversight.

### Content-Type is not verified

The presigned PUT this object was uploaded through signs only the `host` header (`X-Amz-SignedHeaders=host` — an existing ADR-087 trade-off), so nothing constrains what `Content-Type` an uploading client actually sent. There is also no reliable mapping between this domain's business-level `fileType` vocabulary (`PDF`/`JPG`/`JPEG`/`PNG`) and a MIME `Content-Type` string. `StorageService.verifyObjectUploaded` therefore checks existence and `Content-Length` only, and its own doc comment discloses this explicitly rather than silently skipping a check a reader might assume happens.

### Bulk upload

Considered and rejected: disabling bulk upload outright once storage is configured. This would silently regress a real, source-specified feature (08.09 Rule 018) the moment an operator turns storage on, for no security benefit over per-item validation. Instead, each item in a bulk request is validated against its own `DocumentUploadIntent` exactly as the single-document endpoint is — one presigned upload-url request per file, as a client would already do for N sequential single uploads. A bad intent on one item fails only that item's own `results[]` entry, preserving the existing partial-failure semantics.

### Compatibility

When storage is **not** configured, `resolveUploadIntent` returns immediately with no validation — the exact pre-ADR-087 legacy behavior (an opaque, trusted client-supplied `fileUrl`) is unchanged. This is what keeps this sandbox's own e2e/CI environment (no `STORAGE_*` vars set) regression-free. When storage **is** configured, an arbitrary/unknown `fileUrl` is now rejected (404) — this is the intended, disclosed behavior change this ADR exists to make.

**Resolved in a follow-up pass:** `test/documents.e2e-spec.ts`'s and `test/notifications.e2e-spec.ts`'s own document-creation fixtures originally used arbitrary client-supplied `fileUrl` strings (the legacy shape), which this hardening pass's `resolveUploadIntent` rejects once storage is configured. Both files' independent, duplicated `createDocument` helpers were replaced with one shared implementation (`test/helpers/create-document.ts`) that requests a real upload-intent, PUTs real bytes, and finalizes with the returned `storageKey` whenever storage is configured (falling back to the legacy arbitrary `fileUrl` when it isn't, so a storage-less environment stays regression-free). Every 201-success path in both files — direct create-document calls, version-upload calls, and bulk-upload items expected to succeed — was audited and migrated; negative-path tests that fail earlier in the service's own validation order (membership/category/fileType/archived-state, all of which run before the upload-intent check) were deliberately left on the legacy arbitrary `fileUrl`, since they never reach that check. Confirmed via the full e2e run recorded in Verification status below.

### Version-history contract follow-up

Mobile Documents MD-05B required a read contract for versions already persisted by
this upload flow. `GET /documents/:documentId/versions` now returns metadata only,
newest-first by `versionNumber DESC, id DESC`, using the platform's canonical
`page`/`limit` query and `metadata.pagination` response contract. It reuses the
same building-membership and `DocumentPolicy` visibility checks as document detail
and version download. Raw `fileUrl`/object paths and presigned URLs are not exposed;
an item discovered in history is downloaded only through the existing authorized
`GET /document-versions/:versionId/download` endpoint. Archived history remains
readable because the existing detail/download read policy permits it. This makes
the backend contract available for MD-05B without claiming the mobile UI itself is
implemented.

## Consequences

- Closes a real, confirmed trust-boundary gap: a `fileUrl`/`storageKey` can no longer be recorded as Document metadata without proof the caller was actually issued a presigned URL for it and actually uploaded to it.
- Adds one new table (`document_upload_intents`) and one new enum (`DocumentUploadPurpose`) to the schema, plus three new indexes.
- Adds one required field (`purpose`) and one conditionally-required field (`documentId`) to `POST :id/documents/upload-url`'s request body — a breaking API contract change for any existing client of that endpoint once this ships. `uploadIntentId` is added to that endpoint's response (additive, non-breaking).
- Adds one real network round-trip (a presigned HEAD Object request) to `createDocument`/`uploadVersion`/each bulk item, only when storage is configured.
- `test/documents.e2e-spec.ts` and `test/notifications.e2e-spec.ts` were migrated onto the real upload-intent flow via a shared fixture helper (see "Resolved in a follow-up pass" above) — no suite in this repository still assumes the pre-ADR-121 arbitrary-`fileUrl` contract when storage is configured.
- Adds a paginated, metadata-only version-history read endpoint without changing
  the schema or the upload/download storage contracts.

## Verification status

Implemented, unit-tested, and verified end-to-end against a real stack:

- **Unit tests:** `DocumentRepository.spec.ts`, `DocumentsService.spec.ts`, `StorageService.spec.ts` (Prisma/`fetch` mocked) — 70/70 targeted tests passed; 821/821 in the full unit suite.
- **Targeted e2e suites:** 3/3 suites passed, 79/79 tests passed.
- **Real MinIO round-trip:** a real presigned PUT followed by a real presigned GET against a live MinIO instance — bytes matched. PASS.
- **Full e2e suite:** 32/32 suites, 802/802 tests passed against a real Postgres + Redis + MinIO stack, including `test/documents-storage.e2e-spec.ts`'s full `STORAGE_CONFIGURED_FOR_TEST` scenario set (arbitrary-fileUrl rejection, pre-upload rejection, size-mismatch rejection, intent-reuse rejection, wrong-document-binding rejection, per-item bulk validation) and the migrated `test/documents.e2e-spec.ts`/`test/notifications.e2e-spec.ts` fixtures.
- **Build:** PASS.

These results were produced and confirmed on the user's own local machine (real Docker/Postgres/Redis/MinIO), not in the sandbox this pass was otherwise implemented in — that sandbox has no Docker or outbound network access and could only run static/unit verification (`tsc`, `eslint`, mocked unit tests). The final code review pass (post-verification) found no additional defects requiring a code change to this ADR's design.
