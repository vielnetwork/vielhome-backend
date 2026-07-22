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
   * when the resulting `Document`/`DocumentVersion` is recorded — but
   * nothing server-side re-verifies the ACTUAL uploaded bytes match those
   * declared values. An explicit, disclosed trust boundary, not an
   * oversight — see this ADR's own Future Review.
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

  private presign(method: 'GET' | 'PUT', key: string, expiresInSeconds: number): string {
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
}
