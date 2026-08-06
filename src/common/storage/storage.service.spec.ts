import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { UnexpectedAppError } from '../errors/app-error';
import type { AppConfig } from '../../config/configuration';

function makeConfigService(
  storage: Partial<AppConfig['storage']> = {},
): ConfigService<AppConfig, true> {
  const full: AppConfig['storage'] = {
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    forcePathStyle: true,
    useSsl: true,
    ...storage,
  };
  return {
    get: (_key: string) => full,
  } as unknown as ConfigService<AppConfig, true>;
}

const CONFIGURED = {
  endpoint: 'localhost:9000',
  bucket: 'vielhome-documents',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin-secret',
};

describe('StorageService', () => {
  describe('isConfigured', () => {
    it('is false when any of endpoint/bucket/accessKeyId/secretAccessKey is empty', () => {
      expect(new StorageService(makeConfigService()).isConfigured()).toBe(false);
      expect(new StorageService(makeConfigService({ endpoint: 'x' })).isConfigured()).toBe(false);
      expect(
        new StorageService(makeConfigService({ ...CONFIGURED, bucket: '' })).isConfigured(),
      ).toBe(false);
    });

    it('is true once all four are set', () => {
      expect(new StorageService(makeConfigService(CONFIGURED)).isConfigured()).toBe(true);
    });
  });

  describe('when not configured', () => {
    const service = new StorageService(makeConfigService());

    it('getPresignedUploadUrl throws UnexpectedAppError, not a silent no-op', () => {
      expect(() => service.getPresignedUploadUrl('documents/b1/x.pdf')).toThrow(UnexpectedAppError);
    });

    it('getPresignedDownloadUrl throws UnexpectedAppError', () => {
      expect(() => service.getPresignedDownloadUrl('documents/b1/x.pdf')).toThrow(
        UnexpectedAppError,
      );
    });

    it('buildObjectKey still works — key naming needs no storage config', () => {
      expect(service.buildObjectKey('b1', 'lease.pdf')).toMatch(
        /^documents\/b1\/\d{4}\/\d{2}\/[0-9a-z]{12}-lease\.pdf$/,
      );
    });
  });

  describe('when configured (path-style, MinIO-shaped)', () => {
    const service = new StorageService(makeConfigService(CONFIGURED));

    it('getPresignedUploadUrl returns a path-style URL (bucket in the path, not the host)', () => {
      const { uploadUrl, storageKey, expiresAt } = service.getPresignedUploadUrl(
        'documents/b1/2026/07/abc-lease.pdf',
      );
      expect(uploadUrl.startsWith('https://localhost:9000/vielhome-documents/documents/')).toBe(
        true,
      );
      expect(uploadUrl).toContain('X-Amz-Signature=');
      expect(storageKey).toBe('documents/b1/2026/07/abc-lease.pdf');
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('getPresignedDownloadUrl signs a GET, not a PUT', () => {
      const url = service.getPresignedDownloadUrl('documents/b1/2026/07/abc-lease.pdf');
      expect(url).toContain('X-Amz-Signature=');
      // Different verb -> different signature than an upload URL for the same key.
      const upload = service.getPresignedUploadUrl('documents/b1/2026/07/abc-lease.pdf').uploadUrl;
      const uploadSig = upload.match(/X-Amz-Signature=([0-9a-f]+)$/)?.[1];
      const downloadSig = url.match(/X-Amz-Signature=([0-9a-f]+)$/)?.[1];
      expect(uploadSig).not.toBe(downloadSig);
    });

    it('expiresAt honors a custom expiresInSeconds', () => {
      const before = Date.now();
      const { expiresAt } = service.getPresignedUploadUrl('documents/b1/x.pdf', 60);
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(before + 60_000 + 5000);
    });
  });

  describe('when configured for virtual-hosted style (real AWS S3 shape)', () => {
    it('puts the bucket in the host, not the path', () => {
      const service = new StorageService(
        makeConfigService({
          endpoint: 's3.us-east-1.amazonaws.com',
          bucket: 'vielhome-prod-documents',
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'secret',
          forcePathStyle: false,
        }),
      );
      const { uploadUrl } = service.getPresignedUploadUrl('documents/b1/x.pdf');
      expect(
        uploadUrl.startsWith(
          'https://vielhome-prod-documents.s3.us-east-1.amazonaws.com/documents/',
        ),
      ).toBe(true);
    });
  });

  describe('buildObjectKey', () => {
    const service = new StorageService(makeConfigService(CONFIGURED));

    it('sanitizes unsafe characters out of the file name portion', () => {
      const key = service.buildObjectKey('b1', 'قرارداد اجاره (نهایی)!.pdf');
      expect(key).toMatch(/^documents\/b1\/\d{4}\/\d{2}\/[0-9a-z]{12}-.*\.pdf$/);
      // Only the safe charset survives in the key itself.
      expect(key).not.toMatch(/[^\x00-\x7F]/);
    });

    it('produces a different key each call, even for the same file name (collision-safe)', () => {
      const a = service.buildObjectKey('b1', 'lease.pdf');
      const b = service.buildObjectKey('b1', 'lease.pdf');
      expect(a).not.toBe(b);
    });
  });

  // 21_ADRs > ADR-108 — real reachability check for the Monitoring
  // overview endpoint. `fetch` is mocked at the global level so these
  // tests never make a real network call.
  describe('checkBucketHealth', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('reports configured:false and does not attempt any request when storage is not configured', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;
      const service = new StorageService(makeConfigService());

      const result = await service.checkBucketHealth();

      expect(result).toEqual({ configured: false, reachable: false, bucketAccessible: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports reachable:true and bucketAccessible:true on a 200 HEAD response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.checkBucketHealth();

      expect(result).toEqual({ configured: true, reachable: true, bucketAccessible: true });
    });

    it('reports reachable:true but bucketAccessible:false on a non-200 HEAD response (e.g. 403/404)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 403 }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.checkBucketHealth();

      expect(result).toEqual({ configured: true, reachable: true, bucketAccessible: false });
    });

    it('reports reachable:false and bucketAccessible:false when the request throws (network error/timeout)', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:9000')) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.checkBucketHealth();

      expect(result).toEqual({ configured: true, reachable: false, bucketAccessible: false });
    });

    it('the HEAD request URL never contains the secret access key in plain query form beyond the signature itself, and never logs raw error detail', async () => {
      let capturedUrl = '';
      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({ status: 200 });
      }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      await service.checkBucketHealth();

      expect(capturedUrl).toContain('X-Amz-Signature=');
      expect(capturedUrl).not.toContain(CONFIGURED.secretAccessKey);
    });
  });

  // Documents Phase 1a Hardening (post-audit, Section E) — real
  // presigned-HEAD-Object verification. `fetch` is mocked at the global
  // level, same discipline as `checkBucketHealth` above — these tests
  // never make a real network call, and are NOT a substitute for the real
  // MinIO/S3 round trip this ADR's own doc comment on `verifyObjectUploaded`
  // discloses as unverified from this sandbox.
  describe('verifyObjectUploaded', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('throws UnexpectedAppError immediately when storage is not configured, without attempting any request', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;
      const service = new StorageService(makeConfigService());

      await expect(service.verifyObjectUploaded('documents/b1/x.pdf', 1024)).rejects.toThrow(
        UnexpectedAppError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports exists:true with no size mismatch when Content-Length matches the expected size', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? '1024' : null) },
      }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.verifyObjectUploaded('documents/b1/x.pdf', 1024);

      expect(result).toEqual({ exists: true, actualSizeBytes: 1024, sizeMismatch: false });
    });

    it('reports sizeMismatch:true when Content-Length differs from the expected size', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? '500' : null) },
      }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.verifyObjectUploaded('documents/b1/x.pdf', 1024);

      expect(result).toEqual({ exists: true, actualSizeBytes: 500, sizeMismatch: true });
    });

    it('reports exists:true with no sizeMismatch claim when the storage response omits Content-Length', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => null },
      }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.verifyObjectUploaded('documents/b1/x.pdf', 1024);

      expect(result).toEqual({ exists: true });
    });

    it('reports exists:false on a 404 (object never uploaded)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 404,
        headers: { get: () => null },
      }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.verifyObjectUploaded('documents/b1/x.pdf', 1024);

      expect(result).toEqual({ exists: false });
    });

    it('reports exists:false (never throws) on a network error/timeout', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:9000')) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      const result = await service.verifyObjectUploaded('documents/b1/x.pdf', 1024);

      expect(result).toEqual({ exists: false });
    });

    it('signs a HEAD request against the object key itself, not the bucket root', async () => {
      let capturedUrl = '';
      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({ status: 200, headers: { get: () => null } });
      }) as unknown as typeof fetch;
      const service = new StorageService(makeConfigService(CONFIGURED));

      await service.verifyObjectUploaded('documents/b1/2026/07/abc-lease.pdf', 1024);

      expect(capturedUrl).toContain('/documents/b1/2026/07/abc-lease.pdf');
      expect(capturedUrl).toContain('X-Amz-Signature=');
      expect(capturedUrl).not.toContain(CONFIGURED.secretAccessKey);
    });
  });
});
