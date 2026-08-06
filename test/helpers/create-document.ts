import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

/**
 * Documents Phase 1a Hardening (ADR-121) — shared e2e document-creation
 * fixture helpers.
 *
 * Before this ADR, `documents.e2e-spec.ts` and `notifications.e2e-spec.ts`
 * each independently defined a byte-for-byte identical `createDocument`
 * helper that called `POST :id/documents` with an arbitrary,
 * never-issued `fileUrl` string (e.g. `https://storage.example.com/
 * e2e-file.pdf`). That was a legitimate contract before ADR-121: nothing
 * validated `fileUrl` against real storage.
 *
 * ADR-121 closed that trust-boundary gap: once storage is configured,
 * `createDocument`/`uploadVersion`/`bulkCreateDocuments` now validate the
 * submitted `fileUrl` against a real, unconsumed `DocumentUploadIntent`
 * and HEAD-verify the object exists in storage — an arbitrary
 * client-supplied `fileUrl` is now rejected with 404 (`NOT_FOUND`, no
 * matching intent). That is exactly what broke every 201-success path in
 * both files that still built its own arbitrary `fileUrl` — either
 * through the (now deleted) duplicate `createDocument` copies, or
 * inline, directly in a test body.
 *
 * Everything here branches on `STORAGE_CONFIGURED_FOR_TEST` (computed
 * the same way `StorageService.isConfigured()` does, from the same four
 * env vars):
 *
 * - Storage NOT configured: unchanged pre-ADR-121 behavior — an
 *   arbitrary `fileUrl` — because `resolveUploadIntent` is a documented
 *   no-op passthrough in this state. This keeps any storage-less
 *   environment (this sandbox's own default CI) regression-free.
 * - Storage configured: performs the real flow the API now requires —
 *   request a presigned upload URL, PUT real bytes matching the declared
 *   `fileSize` exactly, then finalize with the returned `storageKey`.
 *
 * `overrides.fileUrl` is deliberately never honored, in either branch —
 * a caller cannot bypass the presign flow by passing its own `fileUrl`
 * (Documents Phase 1a Hardening follow-up hardening). Every field these
 * helpers compute themselves (`fileUrl`/`fileName`/`fileType`/
 * `fileSize`) is applied to the outgoing request AFTER `...overrides` is
 * spread, so no override key can silently clobber a value the intent
 * was actually requested and uploaded against — doing so would desync
 * the request body from what storage was told to expect and break the
 * HEAD-verify server-side.
 */
export const STORAGE_CONFIGURED_FOR_TEST = Boolean(
  process.env.STORAGE_ENDPOINT &&
  process.env.STORAGE_BUCKET &&
  process.env.STORAGE_ACCESS_KEY_ID &&
  process.env.STORAGE_SECRET_ACCESS_KEY,
);

const LEGACY_FILE_URL = 'https://storage.example.com/e2e-file.pdf';

interface UploadIntentExtras {
  purpose?: 'CREATE_DOCUMENT' | 'CREATE_VERSION';
  documentId?: string;
}

async function issueAndUploadRealObject(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  fileName: string,
  fileType: string,
  fileSize: number,
  extras: UploadIntentExtras = {},
): Promise<string> {
  const intentRes = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      fileName,
      fileType,
      fileSize,
      purpose: extras.purpose ?? 'CREATE_DOCUMENT',
      ...(extras.documentId ? { documentId: extras.documentId } : {}),
    })
    .expect(201);

  const { uploadUrl, storageKey } = intentRes.body.data as {
    uploadUrl: string;
    storageKey: string;
  };

  const putRes = await fetch(uploadUrl, { method: 'PUT', body: Buffer.alloc(fileSize, 'e') });
  if (!putRes.ok) {
    throw new Error(
      `e2e document-upload test helper: presigned PUT to storage failed ` +
        `(${putRes.status} ${putRes.statusText}) — is the configured storage ` +
        `backend (STORAGE_ENDPOINT=${process.env.STORAGE_ENDPOINT}) reachable?`,
    );
  }

  return storageKey;
}

/**
 * Returns a real, storage-backed `fileUrl` (a `storageKey` a real object
 * was actually PUT to) when storage is configured, or the pre-ADR-121
 * legacy arbitrary `fileUrl` when it is not. For e2e test bodies that
 * build their own custom `POST :id/documents` / `POST :id/versions` /
 * bulk-item payload — with specific `fileName`/`fileType`/`fileSize`/
 * category combinations the `createDocument`/`uploadDocumentVersion`
 * helpers below don't cover — but still need a `fileUrl` that will pass
 * `resolveUploadIntent` once storage is configured.
 *
 * Pass `purpose: 'CREATE_VERSION'` + `documentId` for a version-upload
 * intent bound to that specific document; omit both for a
 * `CREATE_DOCUMENT` intent (the default).
 */
export async function requestRealFileUrl(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  params: {
    fileName: string;
    fileType: string;
    fileSize: number;
    purpose?: 'CREATE_DOCUMENT' | 'CREATE_VERSION';
    documentId?: string;
  },
): Promise<string> {
  if (!STORAGE_CONFIGURED_FOR_TEST) {
    return LEGACY_FILE_URL;
  }
  return issueAndUploadRealObject(
    app,
    buildingId,
    accessToken,
    params.fileName,
    params.fileType,
    params.fileSize,
    { purpose: params.purpose, documentId: params.documentId },
  );
}

/** Creates a document (and its first version) as `accessToken`, returns
 * its id. Defaults to an open GENERAL category and a supported PDF file
 * type so callers only need to override what the test actually cares
 * about. Shared by `documents.e2e-spec.ts` and `notifications.e2e-spec.ts`
 * — see this module's own top-of-file comment for why a single
 * implementation now exists instead of two duplicated copies, and for
 * why `overrides.fileUrl` is never honored. */
export async function createDocument(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<{ documentId: string; versionId: string }> {
  const {
    fileUrl: _ignoredFileUrlOverride,
    fileName: fileNameOverride,
    fileType: fileTypeOverride,
    fileSize: fileSizeOverride,
    ...restOverrides
  } = overrides;
  void _ignoredFileUrlOverride; // never honored — see module comment

  const fileName = (fileNameOverride as string | undefined) ?? 'e2e-file.pdf';
  const fileType = (fileTypeOverride as string | undefined) ?? 'PDF';
  const fileSize = (fileSizeOverride as number | undefined) ?? 1024;

  const fileUrl = await requestRealFileUrl(app, buildingId, accessToken, {
    fileName,
    fileType,
    fileSize,
    purpose: 'CREATE_DOCUMENT',
  });

  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/documents`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      category: 'GENERAL',
      title: 'e2e document',
      description: 'e2e document description',
      ...restOverrides,
      fileUrl,
      fileName,
      fileType,
      fileSize,
    })
    .expect(201);

  return {
    documentId: res.body.data.document.id as string,
    versionId: res.body.data.version.id as string,
  };
}

/** Uploads a new version onto an existing document as `accessToken`.
 * Mirrors `createDocument`'s real upload-intent flow — a `CREATE_VERSION`
 * intent bound to `documentId` — when storage is configured; uses the
 * pre-ADR-121 legacy arbitrary `fileUrl` when it is not.
 * `overrides.fileUrl` is never honored, for the same reason `createDocument`
 * never honors it (see module comment). */
export async function uploadDocumentVersion(
  app: INestApplication,
  buildingId: string,
  documentId: string,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<{ versionId: string; versionNumber: number; isCurrent: boolean }> {
  const {
    fileUrl: _ignoredFileUrlOverride,
    fileName: fileNameOverride,
    fileType: fileTypeOverride,
    fileSize: fileSizeOverride,
    ...restOverrides
  } = overrides;
  void _ignoredFileUrlOverride; // never honored — see module comment

  const fileName = (fileNameOverride as string | undefined) ?? 'e2e-file-v2.pdf';
  const fileType = (fileTypeOverride as string | undefined) ?? 'PDF';
  const fileSize = (fileSizeOverride as number | undefined) ?? 1024;

  const fileUrl = await requestRealFileUrl(app, buildingId, accessToken, {
    fileName,
    fileType,
    fileSize,
    purpose: 'CREATE_VERSION',
    documentId,
  });

  const res = await request(app.getHttpServer())
    .post(`/api/v1/documents/${documentId}/versions`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      ...restOverrides,
      fileUrl,
      fileName,
      fileType,
      fileSize,
    })
    .expect(201);

  return {
    versionId: res.body.data.id as string,
    versionNumber: res.body.data.versionNumber as number,
    isCurrent: res.body.data.isCurrent as boolean,
  };
}

/**
 * Builds one item for `POST :id/documents/bulk`'s `documents[]` array
 * that is expected to actually succeed — with a real, storage-backed
 * `fileUrl` when storage is configured (or the legacy arbitrary `fileUrl`
 * when it isn't). Requests its own upload-url intent and PUTs real bytes
 * as `accessToken`, exactly like `createDocument`, since
 * `bulkCreateDocuments` validates each item against its own intent
 * independently (one presigned upload-url request per file, same as a
 * client doing N sequential single uploads would).
 *
 * A bulk item meant to FAIL bulk validation (bad category/fileType/etc.)
 * should NOT use this — build it as a plain object with whatever invalid
 * field the test is asserting on; the service rejects it before ever
 * reaching the storage/intent check, so it never needs a real intent. */
export async function buildSuccessfulBulkItem(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const {
    fileUrl: _ignoredFileUrlOverride,
    fileName: fileNameOverride,
    fileType: fileTypeOverride,
    fileSize: fileSizeOverride,
    ...restOverrides
  } = overrides;
  void _ignoredFileUrlOverride; // never honored — see module comment

  const fileName = (fileNameOverride as string | undefined) ?? 'e2e-bulk-file.pdf';
  const fileType = (fileTypeOverride as string | undefined) ?? 'PDF';
  const fileSize = (fileSizeOverride as number | undefined) ?? 1024;

  const fileUrl = await requestRealFileUrl(app, buildingId, accessToken, {
    fileName,
    fileType,
    fileSize,
    purpose: 'CREATE_DOCUMENT',
  });

  return {
    category: 'GENERAL',
    title: 'e2e bulk document',
    ...restOverrides,
    fileUrl,
    fileName,
    fileType,
    fileSize,
  };
}
