import { backupMetrics, reconcile } from './backup.reconciliation';
import { BackupError } from './backup.storage';
describe('recovery reconciliation', () => {
  it('detects a finalized version missing its request and missing source', async () => {
    const db: any = {
      documentVersion: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'v', fileUrl: 'key', uploadedAt: new Date(0) }])
          .mockResolvedValue([]),
      },
      objectBackupRequest: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const storage: any = {
      headSource: jest.fn().mockRejectedValue(new BackupError('SOURCE_MISSING')),
    };
    expect(await reconcile(db, 'test-primary', storage)).toMatchObject({
      missingRequests: 1,
      missingSources: 1,
      overdueRequests: 1,
    });
  });
  it('detects invalid verified generation metadata', async () => {
    const db: any = {
      documentVersion: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'v', fileUrl: 'key', uploadedAt: new Date() }])
          .mockResolvedValue([]),
      },
      objectBackupRequest: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ sourceKey: 'key', state: 'VERIFIED', generations: [] }),
      },
    };
    expect(await reconcile(db, 'test-primary', { headSource: jest.fn() } as any)).toMatchObject({
      invalidVerifiedMetadata: 1,
    });
  });
  it('reports distinct verified checksums as a conflict', async () => {
    const gen = (sha256: string) => ({
      verifiedAt: new Date(),
      sha256,
      observedSize: 1n,
      sourceETag: 'e',
      backupKey: 'k',
      manifestKey: 'm',
    });
    const db: any = {
      documentVersion: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'v', fileUrl: 'key', uploadedAt: new Date() }])
          .mockResolvedValue([]),
      },
      objectBackupRequest: {
        findUnique: jest.fn().mockResolvedValue({
          sourceKey: 'key',
          state: 'VERIFIED',
          generations: [gen('a'.repeat(64)), gen('b'.repeat(64))],
        }),
      },
    };
    expect(await reconcile(db, 'test-primary', {} as any)).toMatchObject({
      conflictingGenerations: 1,
    });
  });
  it('exposes aggregate overdue and failed signals using a fifteen-minute cutoff', async () => {
    const now = new Date('2026-09-08T01:00:00Z');
    const db: any = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { unprotected: 2n, oldest: new Date(now.getTime() - 901000), failed: 1n, overdue: 1n },
        ]),
    };
    expect(await backupMetrics(db, 'test-primary', now)).toEqual({
      unprotectedCount: 2,
      oldestUnprotectedAgeSeconds: 901,
      failedCount: 1,
      overdueCount: 1,
    });
    expect(db.$queryRaw.mock.calls[0][0].values).toContainEqual(new Date(now.getTime() - 900000));
  });
});
