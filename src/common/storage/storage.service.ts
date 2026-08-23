import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { customAlphabet } from 'nanoid';
import type { AppConfig } from '../../config/configuration';
import { UnexpectedAppError } from '../errors/app-error';
import { presignUrl, uriEncode } from './sigv4';

const generateKeySuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export interface PresignedUpload {
  uploadUrl: string;
  storageKey: string;
  expiresAt: Date;
}

/**
 * 21_ADRs > ADR-108 — the three distinct, separately-reportable outcomes
 * of a storage health check. See `StorageService.checkBucketHealth`'s own
 * doc comment for what each field actually proves.
 */
export interface StorageHealthResult {
  configured: boolean;
  reachable: boolean;
  bucketAccessible: boolean;
}

/**
 * Documents Phase 1a Hardening (post-audit) — the real, per-object
 * existence/size check `DocumentsService` runs before ever recording a
 * Document/DocumentVersion metadata row, closing the audit's own
 * repeatedly-stated caution: "do not count presigned URL generation as
 * proof upload/download works" and "do not count database metadata
 * creation as successful object storage persistence." See
 * `StorageService.verifyObjectUploaded`'s own doc comment for exactly
 * what is and is not verified.
 */
export interface ObjectVerificationResult {
  exists: boolean;
  /** Only meaningful when `exists` is true; `undefined` if the storage response omitted Content-Length. */
  sizeMismatch?: boolean;
  actualSizeBytes?: number;
}

/**
 * 21_ADRs > ADR-087 — real S3/MinIO-compatible object storage for
 * Documents, closing `ADR-026`'s own Future Review item and the #1 entry
 * in `24_Release_Readiness_Audit_v1.0` §2.1 ("needs a new npm dependency
 * this sandbox can't install/verify").
 *
 * Thin, DI-aware wrapper around the pure signer in `./sigv4.ts` — this
 * class owns config-reading, key naming, and the "not configured" fallback
 * error; `sigv4.ts` owns the actual AWS Signature Version 4 math (kept
 * separate so it can be unit-tested against AWS's own published worked
 * example with no NestJS/config machinery in the way).
 *
 * Deliberately zero new npm dependencies: S3 and MinIO both implement the
 * exact same SigV4 query-auth scheme (MinIO is explicitly S3-API-compatible
 * by design), so this one hand-rolled signer covers real AWS S3 in
 * production and a self-hosted MinIO container in local/dev
 * (`docker-compose.yml`) with only a config-value difference
 * (`forcePathStyle`). `nanoid` (already a declared dependency, previously
 * unused anywhere in `src/`) is the only import beyond Node built-ins and
 * this project's own error taxonomy.
 *
 * `isConfigured()` gates everything: with any of the five `storage.*`
 * config values unset, every presign method throws `UnexpectedAppError`
 * (a clear 500, not a silent no-op) and callers (`DocumentsService`) fall
 * back to this codebase's pre-ADR-087 "client-supplied metadata" behavior
 * — the same "stub until an operator configures the real thing" posture
 * already established for SMS/OTP delivery and Push/Email/SMS
 * Notifications.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('storage', { infer: true });
  }

  isConfigured(): boolean {
    const c = this.cfg;
    return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new UnexpectedAppError(
        'Object storage is not configured on this server ' +
          '(STORAGE_ENDPOINT/STORAGE_BUCKET/STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY). ' +
          'See README > Known risk areas.',
      );
    }
  }

  /**
   * `documents/{buildingId}/{yyyy}/{mm}/{unique}-{sanitizedFileName}` —
   * building-partitioned so a future per-building storage-usage report or
   * bulk export can prefix-scan cheaply (no such report exists yet — this
   * is forward-looking key design, not a built feature); date-partitioned
   * so no single "directory" grows unbounded. `fileName` is sanitized to a
   * conservative safe charset for the STORAGE KEY only — the original name
   * is still stored verbatim in `DocumentVersion.fileName` (untouched by
   * this ADR).
   */
  buildObjectKey(buildingId: string, fileName: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const sanitized = fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(-140);
    return `documents/${buildingId}/${yyyy}/${mm}/${generateKeySuffix()}-${sanitized}`;
  }

  buildAdvertisingCampaignObjectKey(campaignId: string | undefined, fileName: string): string {
    const sanitized = fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(-140);
    const owner =
      campaignId
        ?.trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 100) || `draft-${generateKeySuffix()}`;
    return `advertising/campaigns/${owner}/${generateKeySuffix()}-${sanitized}`;
  }

  /**
   * Presigned PUT — the client uploads directly to storage, never
   * proxying file bytes through this API server (avoids the memory/
   * timeout cost of streaming large files through Nest for what would
   * otherwise be a pure pass-through). Deliberately signs only the `host`
   * header (`X-Amz-SignedHeaders=host`), not `content-type`/
   * `content-length` — a common, disclosed trade-off for browser-uploaded
   * presigned URLs: it avoids an entire class of signature-mismatch bugs
   * between what the server presigned and what the client's PUT actually
   * sends, at the cost of the URL not cryptographically binding the
   * uploaded content's exact type/size. `fileType`/`fileSize` are still
   * policy-checked (`DocumentPolicy.assertFileTypeSupported`/
   * `assertFileSizeWithinLimit`) before a URL is ever issued, and again
   * when the resulting `Document`/`DocumentVersion` is recorded. The
   * presigned PUT itself still does not bind `Content-Type`/
   * `Content-Length` — nothing stops a client from sending different
   * values than it declared. Documents Phase 1a Hardening closed part of
   * this gap: the finalize path (`DocumentsService.resolveUploadIntent`,
   * called from `createDocument`/`uploadVersion`/`bulkCreateDocuments`)
   * now issues a real presigned HEAD Object request via
   * `verifyObjectUploaded` and rejects the upload if the object doesn't
   * exist or its actual `Content-Length` doesn't match the declared
   * `fileSize`. MIME-type/magic-byte/content verification is still NOT
   * implemented — `Content-Type` and the actual file contents remain
   * unverified. An explicit, disclosed trust boundary, not an oversight —
   * see this ADR's own Future Review and ADR-121.
   */
  getPresignedUploadUrl(storageKey: string, expiresInSeconds = 900): PresignedUpload {
    this.assertConfigured();
    const uploadUrl = this.presign('PUT', storageKey, expiresInSeconds);
    return {
      uploadUrl,
      storageKey,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  /** Presigned GET — replaces the pre-ADR-087 "return the raw stored fileUrl" behavior once storage is configured; see `DocumentsService.downloadVersion`. */
  getPresignedDownloadUrl(storageKey: string, expiresInSeconds = 300): string {
    this.assertConfigured();
    return this.presign('GET', storageKey, expiresInSeconds);
  }

  async readObjectPrefix(
    storageKey: string,
    byteCount = 16,
    timeoutMs = 5000,
  ): Promise<Uint8Array> {
    this.assertConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.presign('GET', storageKey, 30), {
        headers: { Range: `bytes=0-${byteCount - 1}` },
        signal: controller.signal,
      });
      if (response.status !== 206) {
        throw new UnexpectedAppError('Stored image could not be read for validation.');
      }
      return new Uint8Array(await response.arrayBuffer()).slice(0, byteCount);
    } finally {
      clearTimeout(timeout);
    }
  }

  async deleteObject(storageKey: string, timeoutMs = 5000): Promise<void> {
    this.assertConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.presign('DELETE', storageKey, 30), {
        method: 'DELETE',
        signal: controller.signal,
      });
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
        throw new UnexpectedAppError('Stored object cleanup failed.');
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 21_ADRs > ADR-108 — real reachability check for the Monitoring
   * overview endpoint, closing the gap this class's own `isConfigured()`
   * doc comment names: it "only measures configured, not real health."
   * Presigns a HeadBucket request (bucket-root path, no body,
   * `UNSIGNED-PAYLOAD` — the exact same signing path
   * `getPresignedUploadUrl`/`getPresignedDownloadUrl` already use) and
   * issues it with Node's built-in `fetch` (Node 18+; no new npm
   * dependency, same posture as the rest of this file) — an independent
   * `AbortController` timeout, no retry.
   *
   * Three distinct, separately-reportable outcomes, per ADR-108's
   * explicit requirement — a caller must never collapse these into one
   * boolean:
   * - `configured`: this server has all five `storage.*` values set. Says
   *   nothing about whether the endpoint is actually reachable.
   * - `reachable`: the HTTP request reached the storage endpoint and got
   *   back *some* HTTP response (even a 403/404) — proves DNS/TLS/network
   *   path is alive, independent of whether the specific bucket exists or
   *   these credentials can read it.
   * - `bucketAccessible`: the response status was exactly 200 — the
   *   specific configured bucket exists and is readable with these
   *   credentials.
   *
   * Never returns, logs, or throws the endpoint, bucket name, access key,
   * secret, or any response body/XML — only these three booleans. A
   * network-level failure (DNS, TLS, timeout, connection refused) logs
   * only the error's `name` (e.g. `AbortError`, `TypeError`), never its
   * `message` (which can embed the target URL/hostname).
   */
  async checkBucketHealth(timeoutMs = 3000): Promise<StorageHealthResult> {
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, bucketAccessible: false };
    }

    const url = this.presignHeadBucket(30);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      return { configured: true, reachable: true, bucketAccessible: res.status === 200 };
    } catch (err) {
      this.logger.warn(
        `Storage bucket-health HEAD check failed: ${err instanceof Error ? err.name : 'unknown error'}`,
      );
      return { configured: true, reachable: false, bucketAccessible: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Documents Phase 1a Hardening (post-audit) — real presigned HEAD Object
   * verification, run by `DocumentsService` after intent validation but
   * BEFORE the intent is consumed/the Document metadata is written (see
   * that service's own comment on the exact sequencing and the disclosed
   * race window between this check and the atomic consume+create that
   * follows it). Uses the same signing path as `getPresignedUploadUrl`/
   * `getPresignedDownloadUrl`/`checkBucketHealth` — just against the
   * object's own key rather than the bucket root.
   *
   * What this proves: the object exists at this exact key in this exact
   * bucket (`exists: true` only on a real HTTP 200), and — when the
   * storage backend returns a `Content-Length` header — that its actual
   * byte size matches what the client declared (`sizeMismatch`).
   *
   * What this deliberately does NOT verify: `Content-Type`. The presigned
   * PUT this object was uploaded through signs only the `host` header
   * (`X-Amz-SignedHeaders=host` — see `getPresignedUploadUrl`'s own doc
   * comment), so nothing constrains what Content-Type header, if any, the
   * uploading client actually sent; there is also no reliable mapping
   * between this domain's business-level `fileType` vocabulary
   * (PDF/JPG/JPEG/PNG) and a MIME `Content-Type` string to compare against
   * even if there were. Comparing an untrusted, unsigned header against a
   * different vocabulary would be false confidence, not a real check — so
   * this is disclosed as unverified rather than silently "checked."
   *
   * Never throws on a missing object or a network failure — both are
   * reported as `exists: false` (indistinguishable from each other to the
   * caller, which is the correct, conservative default: "prove it
   * exists," not "prove it doesn't"). Only the error's `name`, never its
   * `message`, is logged on a network-level failure — same posture as
   * `checkBucketHealth`.
   */
  async verifyObjectUploaded(
    storageKey: string,
    expectedSizeBytes: number,
    timeoutMs = 5000,
  ): Promise<ObjectVerificationResult> {
    this.assertConfigured();
    const url = this.presign('HEAD', storageKey, 30);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      if (res.status !== 200) {
        return { exists: false };
      }
      const contentLengthHeader = res.headers.get('content-length');
      if (contentLengthHeader === null) {
        // Storage backend didn't report a size — can't compare, so don't
        // claim a mismatch that was never actually checked.
        return { exists: true };
      }
      const actualSizeBytes = Number(contentLengthHeader);
      return {
        exists: true,
        actualSizeBytes,
        sizeMismatch: actualSizeBytes !== expectedSizeBytes,
      };
    } catch (err) {
      this.logger.warn(
        `Storage HEAD-object verification failed: ${err instanceof Error ? err.name : 'unknown error'}`,
      );
      return { exists: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private presign(
    method: 'DELETE' | 'GET' | 'PUT' | 'HEAD',
    key: string,
    expiresInSeconds: number,
  ): string {
    const c = this.cfg;
    const host = c.forcePathStyle ? c.endpoint : `${c.bucket}.${c.endpoint}`;
    const canonicalUri = c.forcePathStyle
      ? `/${uriEncode(c.bucket, false)}/${uriEncode(key, false)}`
      : `/${uriEncode(key, false)}`;

    const url = presignUrl(
      { method, host, canonicalUri, expiresInSeconds, useSsl: c.useSsl },
      { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region },
    );
    this.logger.debug(`Presigned ${method} ${key} (expires in ${expiresInSeconds}s)`);
    return url;
  }

  /** Bucket-root path (path-style: `/{bucket}`; virtual-hosted: `/`, since the host itself is already bucket-scoped) — a HeadBucket request has no object key. */
  private presignHeadBucket(expiresInSeconds: number): string {
    const c = this.cfg;
    const host = c.forcePathStyle ? c.endpoint : `${c.bucket}.${c.endpoint}`;
    const canonicalUri = c.forcePathStyle ? `/${uriEncode(c.bucket, false)}` : `/`;
    return presignUrl(
      { method: 'HEAD', host, canonicalUri, expiresInSeconds, useSsl: c.useSsl },
      { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region },
    );
  }
}
