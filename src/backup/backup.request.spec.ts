import { enqueueDocumentBackup } from './backup.request';
import { DocumentRepository } from '../modules/documents/infrastructure/repositories/document.repository';

describe('document and receipt transactional integration', () => {
  const oldBucket = process.env.STORAGE_BUCKET;
  beforeEach(() => {
    process.env.STORAGE_BUCKET = 'test-primary';
  });
  afterAll(() => {
    if (oldBucket === undefined) delete process.env.STORAGE_BUCKET;
    else process.env.STORAGE_BUCKET = oldBucket;
  });
  // Transactional test double stages writes; real PostgreSQL verification is a separate gate.
  function fixture(fail = false) {
    let committed: string[] = [];
    const version = { id: 'v', fileUrl: 'documents/opaque', fileSize: 3, uploadedAt: new Date() };
    const db: any = {
      $transaction: async (fn: any) => {
        const pending: string[] = [];
        const tx: any = {
          documentUploadIntent: { updateMany: async () => ({ count: 1 }) },
          document: {
            create: async () => {
              pending.push('document');
              return { id: 'd' };
            },
          },
          documentVersion: {
            create: async () => {
              pending.push('version');
              return version;
            },
            findFirst: async () => null,
            updateMany: async () => ({ count: 1 }),
          },
          documentReference: {
            create: async () => {
              pending.push('reference');
            },
          },
          objectBackupRequest: {
            create: async () => {
              pending.push('request');
              if (fail) throw new Error('DB_FAILURE');
            },
          },
        };
        const result = await fn(tx);
        committed = pending;
        return result;
      },
    };
    return { repo: new DocumentRepository(db), committed: () => committed };
  }
  const params: any = {
    buildingId: 'b',
    createdById: 'u',
    category: 'FINANCIAL',
    title: 'synthetic',
    visibility: 'MEMBERS_ONLY',
    fileUrl: 'documents/opaque',
    fileName: 'synthetic',
    fileType: 'pdf',
    fileSize: 3,
    uploadIntentId: 'intent',
    paymentId: 'p',
    documentId: 'd',
    uploadedById: 'u',
  };
  it.each(['createDocumentWithFirstVersion', 'addVersion', 'createPaymentReceipt'] as const)(
    '%s commits request with version',
    async (method) => {
      const f = fixture();
      await f.repo[method](params);
      expect(f.committed()).toContain('request');
      expect(f.committed()).toContain('version');
    },
  );
  it.each(['createDocumentWithFirstVersion', 'addVersion', 'createPaymentReceipt'] as const)(
    '%s rolls back business writes when request fails',
    async (method) => {
      const f = fixture(true);
      await expect(f.repo[method](params)).rejects.toThrow('DB_FAILURE');
      expect(f.committed()).toEqual([]);
    },
  );
  it('duplicate identity rejection propagates rather than silently losing protection', async () => {
    const tx: any = {
      objectBackupRequest: { create: jest.fn().mockRejectedValue({ code: 'P2002' }) },
    };
    await expect(
      enqueueDocumentBackup(
        tx,
        { id: 'v', fileUrl: 'key', fileSize: 1, uploadedAt: new Date() },
        'test-primary',
      ),
    ).rejects.toEqual({ code: 'P2002' });
  });
  it('has no Redis requirement and uses only transaction delegate', async () => {
    const tx: any = { objectBackupRequest: { create: jest.fn() } };
    await enqueueDocumentBackup(
      tx,
      { id: 'v', fileUrl: 'key', fileSize: 1, uploadedAt: new Date() },
      'test-primary',
    );
    expect(tx.objectBackupRequest.create).toHaveBeenCalledTimes(1);
  });
});
