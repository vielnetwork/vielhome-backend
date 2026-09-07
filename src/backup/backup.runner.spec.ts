import { BackupRunner } from './backup.runner';
import { BackupRepository } from './backup.repository';
import { BackupError, digest } from './backup.storage';

describe('standalone copy pipeline', () => {
  const bytes = Buffer.from('synthetic receipt, no customer data');
  const identity = {
    etag: '"generation-a"',
    lastModified: 'Mon, 07 Sep 2026 00:00:00 GMT',
    size: bytes.length,
  };
  let repo: any, storage: any, objects: Map<string, Buffer>, runner: BackupRunner, sequence: number;
  beforeEach(() => {
    sequence = 0;
    objects = new Map();
    repo = {
      claim: jest.fn().mockResolvedValue({
        id: 'request',
        sourceBucket: 'test-primary',
        sourceKey: 'documents/opaque',
        referenceType: 'DOCUMENT_VERSION',
        referenceId: 'version',
        expectedSize: BigInt(bytes.length),
        attempts: 1,
        leaseOwner: 'owner',
      }),
      createGeneration: jest.fn().mockImplementation(async () => {
        const captureId = `capture-${++sequence}`;
        return {
          id: captureId,
          captureId,
          backupBucket: 'test-backup',
          backupKey: `objects/${captureId}`,
          manifestKey: `manifests/${captureId}`,
          createdAt: new Date(0),
        };
      }),
      verify: jest.fn(),
      fail: jest.fn(),
    };
    storage = {
      headSource: jest.fn().mockResolvedValue(identity),
      readSource: jest.fn().mockResolvedValue(bytes),
      putNew: jest.fn().mockImplementation(async (k: string, b: Buffer) => {
        if (objects.has(k)) throw new BackupError('GENERATION_EXISTS');
        objects.set(k, b);
      }),
      readBackup: jest.fn().mockImplementation(async (k: string) => objects.get(k)),
    };
    runner = new BackupRunner(repo, storage, 'test-backup', 'test');
  });
  it('verifies bytes and an immutable private manifest before VERIFIED', async () => {
    expect(await runner.runOne()).toBe('verified');
    const m = JSON.parse(objects.get('manifests/capture-1')!.toString());
    expect(m).toMatchObject({
      manifestVersion: 1,
      environment: 'test',
      sha256: digest(bytes),
      reference: { type: 'DOCUMENT_VERSION', id: 'version' },
      source: { size: bytes.length },
    });
    expect(m).not.toHaveProperty('fileName');
    expect(m).not.toHaveProperty('contents');
    expect(repo.verify).toHaveBeenCalledTimes(1);
    expect(storage.readBackup.mock.invocationCallOrder[1]).toBeLessThan(
      repo.verify.mock.invocationCallOrder[0],
    );
  });
  it('checksum mismatch never becomes VERIFIED', async () => {
    storage.readBackup.mockResolvedValue(Buffer.from('corrupt'));
    expect(await runner.runOne()).toBe('failed');
    expect(repo.verify).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(expect.anything(), 'CHECKSUM_MISMATCH');
  });
  it('detects source change before writing backup', async () => {
    storage.headSource
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, etag: '"changed"' });
    await runner.runOne();
    expect(storage.putNew).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(expect.anything(), 'SOURCE_CHANGED');
  });
  it('retry creates another generation without overwriting evidence', async () => {
    storage.readBackup.mockRejectedValueOnce(new BackupError('STORAGE_UNAVAILABLE'));
    await runner.runOne();
    const original = objects.get('objects/capture-1');
    expect(await runner.runOne()).toBe('verified');
    expect(objects.get('objects/capture-1')).toEqual(original);
    expect(objects.has('objects/capture-2')).toBe(true);
  });
  it('primary disappearance retains captured generations and records missing source', async () => {
    await runner.runOne();
    storage.headSource.mockRejectedValue(new BackupError('SOURCE_MISSING'));
    await runner.runOne();
    expect(objects.size).toBe(2);
    expect(repo.fail).toHaveBeenLastCalledWith(expect.anything(), 'SOURCE_MISSING');
  });
  it('manifest verification failure prevents VERIFIED', async () => {
    storage.readBackup.mockImplementation(async (k: string) =>
      k.startsWith('manifests') ? Buffer.from('{}') : objects.get(k),
    );
    await runner.runOne();
    expect(repo.verify).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(expect.anything(), 'MANIFEST_MISMATCH');
  });
  it('sanitizes arbitrary errors including provider secrets', async () => {
    storage.headSource.mockRejectedValue(new Error('sensitive provider text'));
    await runner.runOne();
    expect(repo.fail).toHaveBeenCalledWith(expect.anything(), 'BACKUP_FAILED');
  });
  it('idle does not touch storage', async () => {
    repo.claim.mockResolvedValue(null);
    expect(await runner.runOne()).toBe('idle');
    expect(storage.headSource).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL lease boundary', () => {
  it('concurrent compare-and-set admits one owner only', async () => {
    let claimed = false;
    const db: any = {
      objectBackupRequest: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r' }]),
        updateMany: jest.fn().mockImplementation(async () => {
          if (claimed) return { count: 0 };
          claimed = true;
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'r' }),
      },
    };
    const repository = new BackupRepository(db, 'test-primary');
    const results = await Promise.all([repository.claim(), repository.claim()]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('expired COPYING leases are eligible and claimed with a fresh owner', async () => {
    const db: any = {
      objectBackupRequest: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'r' }),
      },
    };
    const now = new Date();
    await new BackupRepository(db, 'test-primary').claim(now);
    expect(db.objectBackupRequest.findMany.mock.calls[0][0].where.OR).toContainEqual({
      state: 'COPYING',
      leaseUntil: { lte: now },
    });
    expect(db.objectBackupRequest.updateMany.mock.calls[0][0].data).toMatchObject({
      state: 'COPYING',
      leaseOwner: expect.any(String),
      attempts: { increment: 1 },
    });
  });
  it('fences a stale owner from committing generation verification', async () => {
    const tx: any = {
      objectBackupRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      objectBackupGeneration: { update: jest.fn() },
    };
    const db: any = { $transaction: async (fn: any) => fn(tx) };
    await expect(
      new BackupRepository(db, 'test-primary').verify(
        { id: 'r', leaseOwner: 'old' } as any,
        { id: 'g' } as any,
        {} as any,
      ),
    ).rejects.toThrow('LEASE_LOST');
    expect(tx.objectBackupGeneration.update).not.toHaveBeenCalled();
  });
});
