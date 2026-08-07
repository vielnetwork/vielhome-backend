import { DocumentRepository } from './document.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConflictError } from '../../../../common/errors/app-error';

/**
 * Documents Phase 1a hardening (Section A) — `DocumentRepository` unit
 * tests. Before this pass this repository had zero unit-level coverage
 * (only exercised indirectly through the e2e suite against a real
 * Postgres instance).
 *
 * `PrismaService` is mocked at the `findMany`/`count` level, following the
 * same pattern as `FinanceRepository`'s own spec — this lets these tests
 * assert the exact shape of the Prisma call (in particular `orderBy` and
 * `where`) without a real database, which is what this sandbox can
 * actually run.
 *
 * Documents Phase 1a Hardening (Sections B-E) — `$transaction` is stubbed
 * to invoke its callback with the same mock object every model method
 * lives on (same pattern `FinanceRepository.spec.ts` uses), so the new
 * `DocumentUploadIntent` create/lookup/atomic-consume tests below can
 * assert the exact sequence of `tx.<model>.<method>` calls a transaction
 * body makes, and that a failed consume rolls back before any
 * Document/DocumentVersion write is attempted.
 */
describe('DocumentRepository', () => {
  let prisma: {
    document: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock };
    documentVersion: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
    documentUploadIntent: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
    documentReference: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let repo: DocumentRepository;

  beforeEach(() => {
    prisma = {
      document: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'doc-1', category: 'GENERAL' }),
      },
      documentVersion: {
        create: jest.fn().mockResolvedValue({ id: 'version-1', versionNumber: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      documentUploadIntent: {
        create: jest.fn().mockResolvedValue({ id: 'intent-1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      documentReference: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    repo = new DocumentRepository(prisma as unknown as PrismaService);
  });

  describe('listDocuments', () => {
    it('orders by createdAt desc with id desc as a deterministic tiebreaker (not createdAt alone)', async () => {
      await repo.listDocuments('building-1', {}, false, { skip: 0, take: 20 });

      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('passes skip/take through to findMany unchanged', async () => {
      await repo.listDocuments('building-1', {}, false, { skip: 40, take: 20 });

      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
    });

    it('excludes MANAGEMENT_ONLY documents in the WHERE clause for a non-privileged caller', async () => {
      await repo.listDocuments('building-1', {}, false, { skip: 0, take: 20 });

      const call = prisma.document.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual(
        expect.arrayContaining([{ visibility: { not: 'MANAGEMENT_ONLY' } }]),
      );
    });

    it('does not add the MANAGEMENT_ONLY exclusion for a privileged caller', async () => {
      await repo.listDocuments('building-1', {}, true, { skip: 0, take: 20 });

      const call = prisma.document.findMany.mock.calls[0][0];
      expect(call.where.AND).not.toEqual(
        expect.arrayContaining([{ visibility: { not: 'MANAGEMENT_ONLY' } }]),
      );
    });

    it('combines an explicit visibility=MANAGEMENT_ONLY filter with the exclusion for a non-privileged caller (unsatisfiable AND, not a leak)', async () => {
      await repo.listDocuments('building-1', { visibility: 'MANAGEMENT_ONLY' }, false, {
        skip: 0,
        take: 20,
      });

      const call = prisma.document.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { visibility: 'MANAGEMENT_ONLY' },
          { visibility: { not: 'MANAGEMENT_ONLY' } },
        ]),
      );
    });

    it('calls count with the exact same where clause used by findMany, so total matches the filtered row set', async () => {
      await repo.listDocuments('building-1', { category: 'MAINTENANCE' }, false, {
        skip: 0,
        take: 20,
      });

      const findManyWhere = prisma.document.findMany.mock.calls[0][0].where;
      const countWhere = prisma.document.count.mock.calls[0][0].where;
      expect(countWhere).toEqual(findManyWhere);
    });

    it('returns { items, total } from findMany/count respectively', async () => {
      const rows = [{ id: 'doc-1' }, { id: 'doc-2' }];
      prisma.document.findMany.mockResolvedValue(rows);
      prisma.document.count.mockResolvedValue(7);

      const result = await repo.listDocuments('building-1', {}, false, { skip: 0, take: 20 });

      expect(result).toEqual({ items: rows, total: 7 });
    });
  });

  describe('searchDocuments', () => {
    it('orders by createdAt desc with id desc as a deterministic tiebreaker', async () => {
      await repo.searchDocuments('building-1', {}, false, { skip: 0, take: 20 });

      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('passes skip/take through to findMany unchanged', async () => {
      await repo.searchDocuments('building-1', {}, false, { skip: 20, take: 10 });

      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('excludes MANAGEMENT_ONLY documents in the WHERE clause for a non-privileged caller', async () => {
      await repo.searchDocuments('building-1', {}, false, { skip: 0, take: 20 });

      const call = prisma.document.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual(
        expect.arrayContaining([{ visibility: { not: 'MANAGEMENT_ONLY' } }]),
      );
    });

    it('calls count with the exact same where clause used by findMany', async () => {
      await repo.searchDocuments('building-1', { title: 'lease' }, false, {
        skip: 0,
        take: 20,
      });

      const findManyWhere = prisma.document.findMany.mock.calls[0][0].where;
      const countWhere = prisma.document.count.mock.calls[0][0].where;
      expect(countWhere).toEqual(findManyWhere);
    });

    it('returns { items, total } from findMany/count respectively', async () => {
      const rows = [{ id: 'doc-1' }];
      prisma.document.findMany.mockResolvedValue(rows);
      prisma.document.count.mockResolvedValue(1);

      const result = await repo.searchDocuments('building-1', {}, false, { skip: 0, take: 20 });

      expect(result).toEqual({ items: rows, total: 1 });
    });
  });

  describe('listDocumentVersions', () => {
    it('filters, paginates, and orders newest-first deterministically', async () => {
      await repo.listDocumentVersions('doc-1', { skip: 2, take: 2 });

      expect(prisma.documentVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { documentId: 'doc-1' },
          orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
          skip: 2,
          take: 2,
        }),
      );
      expect(prisma.documentVersion.count).toHaveBeenCalledWith({
        where: { documentId: 'doc-1' },
      });
    });

    it('selects metadata only and never exposes fileUrl or uploader internals', async () => {
      await repo.listDocumentVersions('doc-1', { skip: 0, take: 20 });

      const select = prisma.documentVersion.findMany.mock.calls[0][0].select;
      expect(select).toEqual({
        id: true,
        documentId: true,
        versionNumber: true,
        fileName: true,
        fileType: true,
        fileSize: true,
        uploadedAt: true,
        isCurrent: true,
        expiresAt: true,
      });
      expect(select).not.toHaveProperty('fileUrl');
      expect(select).not.toHaveProperty('uploadedById');
      expect(select).not.toHaveProperty('uploadedBy');
    });
  });

  describe('CASE attachment targets', () => {
    it('returns distinct Case ids for every version of the document without exposing storage fields', async () => {
      prisma.documentReference.findMany.mockResolvedValue([
        { entityId: 'case-1' },
        { entityId: 'case-2' },
      ]);
      await expect(repo.listCaseReferenceTargetsForDocument('doc-1')).resolves.toEqual([
        'case-1',
        'case-2',
      ]);
      expect(prisma.documentReference.findMany).toHaveBeenCalledWith({
        where: { entityType: 'CASE', documentVersion: { documentId: 'doc-1' } },
        select: { entityId: true },
        distinct: ['entityId'],
      });
    });
  });

  describe('createUploadIntent', () => {
    it('creates a DocumentUploadIntent row with exactly the given fields', async () => {
      const expiresAt = new Date('2026-08-06T10:00:00.000Z');
      await repo.createUploadIntent({
        buildingId: 'building-1',
        storageKey: 'documents/building-1/2026/08/abc-lease.pdf',
        requestedById: 'person-1',
        purpose: 'CREATE_DOCUMENT',
        fileName: 'lease.pdf',
        fileType: 'PDF',
        fileSize: 1024,
        expiresAt,
      });

      expect(prisma.documentUploadIntent.create).toHaveBeenCalledWith({
        data: {
          buildingId: 'building-1',
          storageKey: 'documents/building-1/2026/08/abc-lease.pdf',
          requestedById: 'person-1',
          purpose: 'CREATE_DOCUMENT',
          fileName: 'lease.pdf',
          fileType: 'PDF',
          fileSize: 1024,
          expiresAt,
        },
      });
    });
  });

  describe('findUploadIntentByStorageKey', () => {
    it('looks up by the unique storageKey field', async () => {
      await repo.findUploadIntentByStorageKey('documents/building-1/2026/08/abc-lease.pdf');

      expect(prisma.documentUploadIntent.findUnique).toHaveBeenCalledWith({
        where: { storageKey: 'documents/building-1/2026/08/abc-lease.pdf' },
      });
    });
  });

  describe('createDocumentWithFirstVersion — upload-intent consumption', () => {
    it('does not touch documentUploadIntent at all when uploadIntentId is omitted (legacy/unconfigured-storage path)', async () => {
      await repo.createDocumentWithFirstVersion({
        buildingId: 'building-1',
        category: 'GENERAL',
        title: 'Legacy doc',
        visibility: 'MEMBERS_ONLY',
        createdById: 'person-1',
        fileUrl: 'https://legacy.invalid/x.pdf',
        fileName: 'x.pdf',
        fileType: 'PDF',
        fileSize: 10,
      });

      expect(prisma.documentUploadIntent.updateMany).not.toHaveBeenCalled();
      expect(prisma.document.create).toHaveBeenCalled();
    });

    it('atomically consumes the intent (conditional updateMany on id + consumedAt: null) BEFORE creating the Document', async () => {
      const callOrder: string[] = [];
      prisma.documentUploadIntent.updateMany.mockImplementation(async () => {
        callOrder.push('consumeIntent');
        return { count: 1 };
      });
      prisma.document.create.mockImplementation(async () => {
        callOrder.push('createDocument');
        return { id: 'doc-1', category: 'GENERAL' };
      });

      await repo.createDocumentWithFirstVersion({
        buildingId: 'building-1',
        category: 'GENERAL',
        title: 'New doc',
        visibility: 'MEMBERS_ONLY',
        createdById: 'person-1',
        fileUrl: 'documents/building-1/2026/08/abc-lease.pdf',
        fileName: 'lease.pdf',
        fileType: 'PDF',
        fileSize: 1024,
        uploadIntentId: 'intent-1',
      });

      expect(prisma.documentUploadIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'intent-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
      expect(callOrder).toEqual(['consumeIntent', 'createDocument']);
    });

    it('throws ConflictError and creates no Document when the intent was already consumed (updateMany affects 0 rows)', async () => {
      prisma.documentUploadIntent.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repo.createDocumentWithFirstVersion({
          buildingId: 'building-1',
          category: 'GENERAL',
          title: 'New doc',
          visibility: 'MEMBERS_ONLY',
          createdById: 'person-1',
          fileUrl: 'documents/building-1/2026/08/abc-lease.pdf',
          fileName: 'lease.pdf',
          fileType: 'PDF',
          fileSize: 1024,
          uploadIntentId: 'intent-1',
        }),
      ).rejects.toThrow(ConflictError);

      expect(prisma.document.create).not.toHaveBeenCalled();
      expect(prisma.documentVersion.create).not.toHaveBeenCalled();
    });
  });

  describe('addVersion — upload-intent consumption', () => {
    it('does not touch documentUploadIntent when uploadIntentId is omitted', async () => {
      await repo.addVersion({
        documentId: 'doc-1',
        uploadedById: 'person-1',
        fileUrl: 'https://legacy.invalid/x.pdf',
        fileName: 'x.pdf',
        fileType: 'PDF',
        fileSize: 10,
      });

      expect(prisma.documentUploadIntent.updateMany).not.toHaveBeenCalled();
      expect(prisma.documentVersion.create).toHaveBeenCalled();
    });

    it('atomically consumes the intent before creating the new version', async () => {
      await repo.addVersion({
        documentId: 'doc-1',
        uploadedById: 'person-1',
        fileUrl: 'documents/building-1/2026/08/abc-lease.pdf',
        fileName: 'lease.pdf',
        fileType: 'PDF',
        fileSize: 1024,
        uploadIntentId: 'intent-2',
      });

      expect(prisma.documentUploadIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'intent-2', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('throws ConflictError and creates no version when the intent consume fails (race lost to a concurrent request)', async () => {
      prisma.documentUploadIntent.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repo.addVersion({
          documentId: 'doc-1',
          uploadedById: 'person-1',
          fileUrl: 'documents/building-1/2026/08/abc-lease.pdf',
          fileName: 'lease.pdf',
          fileType: 'PDF',
          fileSize: 1024,
          uploadIntentId: 'intent-2',
        }),
      ).rejects.toThrow(ConflictError);

      expect(prisma.documentVersion.create).not.toHaveBeenCalled();
    });
  });
});
