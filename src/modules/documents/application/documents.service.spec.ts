import { EventEmitter2 } from '@nestjs/event-emitter';
import { DocumentsService } from './documents.service';
import { DocumentRepository } from '../infrastructure/repositories/document.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { DocumentPolicy } from '../domain/policies/document.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { FinanceService } from '../../finance/application/finance.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';

/**
 * Documents Phase 1a hardening (Section A) — `DocumentsService` unit
 * tests for the new `listDocuments`/`searchDocuments` pagination wiring.
 * Before this pass this service had zero unit-level coverage (only the
 * e2e suite, against a real Postgres instance).
 *
 * Scope is deliberately narrow: this covers the pagination/privilege
 * plumbing this pass introduced (page/limit → skip/take, privileged
 * detection passed through to the repository, `meta` built from the
 * repository's `total`), not the full service surface — the same
 * incremental-coverage approach `FinanceService.spec.ts` used for its own
 * hardening pass. `DocumentRepository`/`BuildingRepository`/`AuditService`/
 * `EventEmitter2`/`StorageService` are mocked; `DocumentPolicy` is a real
 * instance (no dependencies of its own, already covered by its own spec).
 *
 * Sections B-G (upload-intent trust-boundary closure) add a second block
 * below covering `requestUploadUrl`/`createDocument`/`uploadVersion`/
 * `bulkCreateDocuments`'s new intent-validation behavior — this is the
 * ONE place that behavior can be unit-tested without a real Postgres +
 * MinIO stack (both `DocumentRepository` and `StorageService` are mocked,
 * so no network/DB I/O actually happens; the real HEAD-object check and
 * real Prisma atomic-consume are covered separately, by
 * `StorageService.spec.ts` and `DocumentRepository.spec.ts` respectively).
 */
describe('DocumentsService — listDocuments / searchDocuments pagination', () => {
  let documents: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let service: DocumentsService;

  const MEMBER_ROLE = ['TENANT'];
  const PRIVILEGED_ROLE = ['MANAGER'];

  beforeEach(() => {
    documents = {
      listDocuments: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      searchDocuments: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    buildings = {
      findById: jest.fn().mockResolvedValue({ id: 'building-1' }),
      getRoles: jest.fn().mockResolvedValue(MEMBER_ROLE),
    };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };
    storage = { isConfigured: jest.fn().mockReturnValue(false) };

    service = new DocumentsService(
      documents as unknown as DocumentRepository,
      buildings as unknown as BuildingRepository,
      new DocumentPolicy(),
      { getCase: jest.fn() } as never,
      { getPaymentForViewer: jest.fn() } as never,
      audit as unknown as AuditService,
      events as unknown as EventEmitter2,
      storage as unknown as StorageService,
    );
  });

  describe('listDocuments', () => {
    it('rejects a non-member outright, before ever calling the repository', async () => {
      buildings.getRoles.mockResolvedValue([]);

      await expect(
        service.listDocuments('building-1', 'person-1', {}, { page: 1, limit: 20 }),
      ).rejects.toThrow();
      expect(documents.listDocuments).not.toHaveBeenCalled();
    });

    it('converts page/limit to skip/take and passes it to the repository unchanged', async () => {
      await service.listDocuments('building-1', 'person-1', {}, { page: 3, limit: 10 });

      expect(documents.listDocuments).toHaveBeenCalledWith('building-1', {}, false, {
        skip: 20,
        take: 10,
      });
    });

    it('passes privileged=false for a plain member and privileged=true for a MANAGER/BOARD_MEMBER/ACCOUNTANT', async () => {
      buildings.getRoles.mockResolvedValue(MEMBER_ROLE);
      await service.listDocuments('building-1', 'person-1', {}, { page: 1, limit: 20 });
      expect(documents.listDocuments).toHaveBeenLastCalledWith('building-1', {}, false, {
        skip: 0,
        take: 20,
      });

      buildings.getRoles.mockResolvedValue(PRIVILEGED_ROLE);
      await service.listDocuments('building-1', 'person-1', {}, { page: 1, limit: 20 });
      expect(documents.listDocuments).toHaveBeenLastCalledWith('building-1', {}, true, {
        skip: 0,
        take: 20,
      });
    });

    it('builds meta from the repository-reported total, not from items.length', async () => {
      documents.listDocuments.mockResolvedValue({ items: [{ id: 'd1' }], total: 47 });

      const result = await service.listDocuments(
        'building-1',
        'person-1',
        {},
        {
          page: 2,
          limit: 20,
        },
      );

      expect(result.meta).toEqual({ page: 2, limit: 20, total: 47, totalPages: 3 });
      expect(result.items).toEqual([{ id: 'd1' }]);
    });
  });

  describe('searchDocuments', () => {
    it('throws NotFoundAppError when the building does not exist', async () => {
      buildings.findById.mockResolvedValue(null);

      await expect(
        service.searchDocuments('missing-building', 'person-1', {}, { page: 1, limit: 20 }),
      ).rejects.toThrow(NotFoundAppError);
    });

    it('converts page/limit to skip/take and passes it to the repository unchanged', async () => {
      await service.searchDocuments(
        'building-1',
        'person-1',
        { title: 'lease' },
        {
          page: 2,
          limit: 5,
        },
      );

      expect(documents.searchDocuments).toHaveBeenCalledWith(
        'building-1',
        { title: 'lease' },
        false,
        { skip: 5, take: 5 },
      );
    });

    it('builds meta from the repository-reported total', async () => {
      documents.searchDocuments.mockResolvedValue({ items: [], total: 0 });

      const result = await service.searchDocuments(
        'building-1',
        'person-1',
        {},
        {
          page: 1,
          limit: 20,
        },
      );

      expect(result.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
    });
  });
});

describe('DocumentsService — version history', () => {
  let documents: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let service: DocumentsService;

  beforeEach(() => {
    documents = {
      findDocumentById: jest.fn().mockResolvedValue({
        id: 'doc-1',
        buildingId: 'building-1',
        visibility: 'MEMBERS_ONLY',
        status: 'ACTIVE',
      }),
      listDocumentVersions: jest.fn().mockResolvedValue({
        items: [{ id: 'v2', versionNumber: 2, isCurrent: true }],
        total: 3,
      }),
      listCaseReferenceTargetsForDocument: jest.fn().mockResolvedValue([]),
      listPaymentReferenceTargetsForDocument: jest.fn().mockResolvedValue([]),
    };
    buildings = {
      getRoles: jest.fn().mockResolvedValue(['TENANT']),
    };
    service = new DocumentsService(
      documents as unknown as DocumentRepository,
      buildings as unknown as BuildingRepository,
      new DocumentPolicy(),
      { getCase: jest.fn() } as never,
      { getPaymentForViewer: jest.fn() } as never,
      { record: jest.fn() } as unknown as AuditService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { isConfigured: jest.fn().mockReturnValue(false) } as unknown as StorageService,
    );
  });

  it('authorizes like document detail and returns canonical pagination metadata', async () => {
    const result = await service.listDocumentVersions('doc-1', 'person-1', {
      page: 2,
      limit: 1,
    });

    expect(documents.listDocumentVersions).toHaveBeenCalledWith('doc-1', {
      skip: 1,
      take: 1,
    });
    expect(result.meta).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
  });

  it('rejects a non-member before querying versions', async () => {
    buildings.getRoles.mockResolvedValue([]);

    await expect(
      service.listDocumentVersions('doc-1', 'outsider', { page: 1, limit: 20 }),
    ).rejects.toThrow(AuthorizationError);
    expect(documents.listDocumentVersions).not.toHaveBeenCalled();
  });

  it('protects MANAGEMENT_ONLY history for a non-privileged member', async () => {
    documents.findDocumentById.mockResolvedValue({
      id: 'doc-1',
      buildingId: 'building-1',
      visibility: 'MANAGEMENT_ONLY',
      status: 'ACTIVE',
    });

    await expect(
      service.listDocumentVersions('doc-1', 'person-1', { page: 1, limit: 20 }),
    ).rejects.toThrow(AuthorizationError);
  });

  it('returns canonical not-found for a missing document', async () => {
    documents.findDocumentById.mockResolvedValue(null);

    await expect(
      service.listDocumentVersions('missing', 'person-1', { page: 1, limit: 20 }),
    ).rejects.toThrow(NotFoundAppError);
  });

  it('allows archived history because existing read policy allows archived detail/download', async () => {
    documents.findDocumentById.mockResolvedValue({
      id: 'doc-1',
      buildingId: 'building-1',
      visibility: 'MEMBERS_ONLY',
      status: 'ARCHIVED',
    });

    await expect(
      service.listDocumentVersions('doc-1', 'person-1', { page: 1, limit: 20 }),
    ).resolves.toEqual(
      expect.objectContaining({ items: [{ id: 'v2', versionNumber: 2, isCurrent: true }] }),
    );
  });
});

describe('DocumentsService — CASE attachment authorization', () => {
  const document = {
    id: 'doc-1',
    buildingId: 'building-1',
    visibility: 'MEMBERS_ONLY',
    status: 'ACTIVE',
  };
  let documents: Record<string, jest.Mock>;
  let cases: { getCase: jest.Mock };
  let service: DocumentsService;

  beforeEach(() => {
    documents = {
      findDocumentById: jest.fn().mockResolvedValue(document),
      getCurrentVersion: jest.fn().mockResolvedValue({ id: 'version-1' }),
      findVersionWithDocument: jest.fn(),
      createReference: jest.fn().mockResolvedValue({ id: 'reference-1' }),
      listCaseReferenceTargetsForDocument: jest.fn().mockResolvedValue([]),
      recordDownload: jest.fn(),
    };
    cases = { getCase: jest.fn().mockResolvedValue({ id: 'case-1' }) };
    service = new DocumentsService(
      documents as unknown as DocumentRepository,
      { getRoles: jest.fn().mockResolvedValue(['TENANT']) } as unknown as BuildingRepository,
      new DocumentPolicy(),
      cases as never,
      { getPaymentForViewer: jest.fn() } as never,
      { record: jest.fn() } as unknown as AuditService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { isConfigured: jest.fn().mockReturnValue(false) } as unknown as StorageService,
    );
  });

  it('validates CASE existence, same-building scope, and CasePolicy visibility before attaching', async () => {
    await service.createReference(
      'doc-1',
      { entityType: 'CASE', entityId: 'case-1' },
      'person-1',
      'request-1',
    );
    expect(cases.getCase).toHaveBeenCalledWith('building-1', 'case-1', 'person-1');
    expect(documents.createReference).toHaveBeenCalledWith({
      documentVersionId: 'version-1',
      entityType: 'CASE',
      entityId: 'case-1',
    });
  });

  it('does not create a reference when CasePolicy denies the target', async () => {
    cases.getCase.mockRejectedValue(new AuthorizationError('private case'));
    await expect(
      service.createReference(
        'doc-1',
        { entityType: 'CASE', entityId: 'case-1' },
        'person-2',
        'request-1',
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(documents.createReference).not.toHaveBeenCalled();
  });

  it('prevents an explicit version from another document being attached', async () => {
    documents.findVersionWithDocument.mockResolvedValue({
      id: 'version-other',
      documentId: 'doc-other',
    });
    await expect(
      service.createReference(
        'doc-1',
        { entityType: 'CASE', entityId: 'case-1', versionId: 'version-other' },
        'person-1',
        'request-1',
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('re-applies CasePolicy on direct document lookup and rejects dangling Case targets', async () => {
    documents.listCaseReferenceTargetsForDocument.mockResolvedValue(['deleted-case']);
    cases.getCase.mockRejectedValue(new NotFoundAppError('Case not found.'));
    await expect(service.getDocument('doc-1', 'person-1')).rejects.toThrow(NotFoundAppError);
  });

  it('re-applies CasePolicy before direct version download', async () => {
    documents.findVersionWithDocument.mockResolvedValue({
      id: 'version-1',
      documentId: 'doc-1',
      document,
      fileUrl: 'internal/storage/key',
      fileName: 'evidence.pdf',
      fileType: 'PDF',
    });
    documents.listCaseReferenceTargetsForDocument.mockResolvedValue(['case-1']);
    cases.getCase.mockRejectedValue(new AuthorizationError('private case'));
    await expect(service.downloadVersion('version-1', 'person-2', 'request-1')).rejects.toThrow(
      AuthorizationError,
    );
    expect(documents.recordDownload).not.toHaveBeenCalled();
  });
});

describe('DocumentsService — upload-intent trust-boundary closure (Sections B-G)', () => {
  let documents: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let service: DocumentsService;

  const MEMBER_ROLE = ['MANAGER'];
  const ACTOR_ID = 'person-1';
  const BUILDING_ID = 'building-1';
  const STORAGE_KEY = 'documents/building-1/2026/08/abc-lease.pdf';
  const EXPIRES_SOON = new Date(Date.now() + 15 * 60 * 1000);

  function validIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'intent-1',
      buildingId: BUILDING_ID,
      storageKey: STORAGE_KEY,
      requestedById: ACTOR_ID,
      purpose: 'CREATE_DOCUMENT',
      documentId: null,
      fileName: 'lease.pdf',
      fileType: 'PDF',
      fileSize: 1024,
      createdAt: new Date(),
      expiresAt: EXPIRES_SOON,
      consumedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    documents = {
      findDocumentById: jest.fn().mockResolvedValue(null),
      createUploadIntent: jest.fn().mockResolvedValue({ id: 'intent-1' }),
      findUploadIntentByStorageKey: jest.fn().mockResolvedValue(null),
      createDocumentWithFirstVersion: jest.fn().mockResolvedValue({
        document: { id: 'doc-1', category: 'GENERAL' },
        version: { id: 'v1' },
      }),
      addVersion: jest.fn().mockResolvedValue({ id: 'v2', versionNumber: 2 }),
    };
    buildings = {
      findById: jest.fn().mockResolvedValue({ id: BUILDING_ID }),
      getRoles: jest.fn().mockResolvedValue(MEMBER_ROLE),
    };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };
    storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      buildObjectKey: jest.fn().mockReturnValue(STORAGE_KEY),
      getPresignedUploadUrl: jest.fn().mockReturnValue({
        uploadUrl: 'https://minio.local/bucket/' + STORAGE_KEY,
        storageKey: STORAGE_KEY,
        expiresAt: EXPIRES_SOON,
      }),
      verifyObjectUploaded: jest.fn().mockResolvedValue({ exists: true, actualSizeBytes: 1024 }),
    };

    service = new DocumentsService(
      documents as unknown as DocumentRepository,
      buildings as unknown as BuildingRepository,
      new DocumentPolicy(),
      { getCase: jest.fn() } as never,
      { getPaymentForViewer: jest.fn() } as never,
      audit as unknown as AuditService,
      events as unknown as EventEmitter2,
      storage as unknown as StorageService,
    );
  });

  describe('requestUploadUrl', () => {
    it.each(['OWNER', 'TENANT', 'BOARD_MEMBER', 'ACCOUNTANT'])(
      'rejects %s before creating a presigned upload intent',
      async (role) => {
        buildings.getRoles.mockResolvedValue([role]);

        await expect(
          service.requestUploadUrl(
            BUILDING_ID,
            {
              fileName: 'lease.pdf',
              fileType: 'PDF',
              fileSize: 1024,
              purpose: 'CREATE_DOCUMENT',
            },
            ACTOR_ID,
          ),
        ).rejects.toThrow(AuthorizationError);
        expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
        expect(documents.createUploadIntent).not.toHaveBeenCalled();
      },
    );

    it('creates a CREATE_DOCUMENT intent and returns uploadIntentId alongside the presigned URL fields', async () => {
      const result = await service.requestUploadUrl(
        BUILDING_ID,
        { fileName: 'lease.pdf', fileType: 'PDF', fileSize: 1024, purpose: 'CREATE_DOCUMENT' },
        ACTOR_ID,
      );

      expect(documents.createUploadIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          buildingId: BUILDING_ID,
          storageKey: STORAGE_KEY,
          requestedById: ACTOR_ID,
          purpose: 'CREATE_DOCUMENT',
          documentId: undefined,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ uploadIntentId: 'intent-1', storageKey: STORAGE_KEY }),
      );
    });

    it('throws ValidationError for CREATE_VERSION with no documentId', async () => {
      await expect(
        service.requestUploadUrl(
          BUILDING_ID,
          { fileName: 'lease.pdf', fileType: 'PDF', fileSize: 1024, purpose: 'CREATE_VERSION' },
          ACTOR_ID,
        ),
      ).rejects.toThrow(ValidationError);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppError for CREATE_VERSION when the target document belongs to a different building', async () => {
      documents.findDocumentById.mockResolvedValue({ id: 'doc-9', buildingId: 'other-building' });

      await expect(
        service.requestUploadUrl(
          BUILDING_ID,
          {
            fileName: 'lease.pdf',
            fileType: 'PDF',
            fileSize: 1024,
            purpose: 'CREATE_VERSION',
            documentId: 'doc-9',
          },
          ACTOR_ID,
        ),
      ).rejects.toThrow(NotFoundAppError);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });

    it('creates a CREATE_VERSION intent bound to documentId when the target document belongs to this building', async () => {
      documents.findDocumentById.mockResolvedValue({ id: 'doc-9', buildingId: BUILDING_ID });

      await service.requestUploadUrl(
        BUILDING_ID,
        {
          fileName: 'lease.pdf',
          fileType: 'PDF',
          fileSize: 1024,
          purpose: 'CREATE_VERSION',
          documentId: 'doc-9',
        },
        ACTOR_ID,
      );

      expect(documents.createUploadIntent).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'CREATE_VERSION', documentId: 'doc-9' }),
      );
    });

    it('never creates an intent when the presign call itself throws (storage not configured — legacy failure preserved)', async () => {
      storage.getPresignedUploadUrl.mockImplementation(() => {
        throw new Error('Object storage is not configured on this server');
      });

      await expect(
        service.requestUploadUrl(
          BUILDING_ID,
          { fileName: 'lease.pdf', fileType: 'PDF', fileSize: 1024, purpose: 'CREATE_DOCUMENT' },
          ACTOR_ID,
        ),
      ).rejects.toThrow();
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });

    it('throws ValidationError when purpose is CREATE_DOCUMENT and documentId is provided', async () => {
      await expect(
        service.requestUploadUrl(
          BUILDING_ID,
          {
            fileName: 'lease.pdf',
            fileType: 'PDF',
            fileSize: 1024,
            purpose: 'CREATE_DOCUMENT',
            documentId: 'doc-9',
          },
          ACTOR_ID,
        ),
      ).rejects.toThrow(ValidationError);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });
  });

  describe('createDocument — intent validation (storage configured)', () => {
    it('rejects direct finalization when the caller is no longer Manager', async () => {
      buildings.getRoles.mockResolvedValue(['OWNER']);

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        AuthorizationError,
      );
      expect(documents.createDocumentWithFirstVersion).not.toHaveBeenCalled();
    });
    const baseDto = {
      category: 'GENERAL' as const,
      title: 'Lease',
      fileUrl: STORAGE_KEY,
      fileName: 'lease.pdf',
      fileType: 'PDF',
      fileSize: 1024,
    };

    it('succeeds, HEAD-verifies the object, and consumes the intent when everything matches', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(validIntent());

      await service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1');

      expect(storage.verifyObjectUploaded).toHaveBeenCalledWith(STORAGE_KEY, 1024);
      expect(documents.createDocumentWithFirstVersion).toHaveBeenCalledWith(
        expect.objectContaining({ uploadIntentId: 'intent-1' }),
      );
    });

    it('skips all intent validation when storage is not configured (legacy passthrough)', async () => {
      storage.isConfigured.mockReturnValue(false);

      await service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1');

      expect(documents.findUploadIntentByStorageKey).not.toHaveBeenCalled();
      expect(storage.verifyObjectUploaded).not.toHaveBeenCalled();
      expect(documents.createDocumentWithFirstVersion).toHaveBeenCalledWith(
        expect.objectContaining({ uploadIntentId: undefined }),
      );
    });

    it('rejects an arbitrary/unknown fileUrl with NotFoundAppError (no matching intent)', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(null);

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        NotFoundAppError,
      );
    });

    it('rejects an already-consumed intent with ConflictError', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ consumedAt: new Date() }),
      );

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        ConflictError,
      );
    });

    it('rejects an expired intent with BusinessRuleViolationError', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects an intent belonging to a different building with AuthorizationError', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ buildingId: 'other-building' }),
      );

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        AuthorizationError,
      );
    });

    it('rejects an intent requested by a different person with AuthorizationError', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ requestedById: 'someone-else' }),
      );

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        AuthorizationError,
      );
    });

    it('rejects a CREATE_VERSION intent used against createDocument with BusinessRuleViolationError', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ purpose: 'CREATE_VERSION', documentId: 'doc-1' }),
      );

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects a fileName/fileType/fileSize mismatch against the intent with ValidationError', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(validIntent({ fileSize: 999 }));

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        ValidationError,
      );
    });

    it('rejects with BusinessRuleViolationError when the object was never actually uploaded (HEAD reports not-exists)', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(validIntent());
      storage.verifyObjectUploaded.mockResolvedValue({ exists: false });

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        BusinessRuleViolationError,
      );
      expect(documents.createDocumentWithFirstVersion).not.toHaveBeenCalled();
    });

    it('rejects with ValidationError when the uploaded object size does not match the declared size', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(validIntent());
      storage.verifyObjectUploaded.mockResolvedValue({
        exists: true,
        sizeMismatch: true,
        actualSizeBytes: 500,
      });

      await expect(service.createDocument(BUILDING_ID, baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        ValidationError,
      );
      expect(documents.createDocumentWithFirstVersion).not.toHaveBeenCalled();
    });
  });

  describe('uploadVersion — intent must be bound to the target document', () => {
    it('rejects direct version finalization when the caller is not Manager', async () => {
      documents.findDocumentById.mockResolvedValue({
        id: 'doc-1',
        buildingId: BUILDING_ID,
        category: 'GENERAL',
        status: 'ACTIVE',
      });
      buildings.getRoles.mockResolvedValue(['ACCOUNTANT']);

      await expect(service.uploadVersion('doc-1', baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        AuthorizationError,
      );
      expect(documents.addVersion).not.toHaveBeenCalled();
    });
    const baseDto = {
      fileUrl: STORAGE_KEY,
      fileName: 'lease.pdf',
      fileType: 'PDF',
      fileSize: 1024,
    };

    beforeEach(() => {
      documents.findDocumentById.mockResolvedValue({
        id: 'doc-1',
        buildingId: BUILDING_ID,
        category: 'GENERAL',
        status: 'ACTIVE',
      });
    });

    it('succeeds and passes uploadIntentId through when the CREATE_VERSION intent is bound to this exact document', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ purpose: 'CREATE_VERSION', documentId: 'doc-1' }),
      );

      await service.uploadVersion('doc-1', baseDto, ACTOR_ID, 'req-1');

      expect(documents.addVersion).toHaveBeenCalledWith(
        expect.objectContaining({ uploadIntentId: 'intent-1' }),
      );
    });

    it('rejects with BusinessRuleViolationError when the intent is bound to a different document', async () => {
      documents.findUploadIntentByStorageKey.mockResolvedValue(
        validIntent({ purpose: 'CREATE_VERSION', documentId: 'some-other-doc' }),
      );

      await expect(service.uploadVersion('doc-1', baseDto, ACTOR_ID, 'req-1')).rejects.toThrow(
        BusinessRuleViolationError,
      );
      expect(documents.addVersion).not.toHaveBeenCalled();
    });
  });

  describe('bulkCreateDocuments — per-item intent validation (Section F)', () => {
    it('rejects the complete bulk creation endpoint for non-Managers', async () => {
      buildings.getRoles.mockResolvedValue(['BOARD_MEMBER']);

      await expect(
        service.bulkCreateDocuments(
          BUILDING_ID,
          {
            documents: [
              {
                category: 'GENERAL',
                title: 'Lease',
                fileUrl: STORAGE_KEY,
                fileName: 'lease.pdf',
                fileType: 'PDF',
                fileSize: 1024,
              },
            ],
          } as never,
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toThrow(AuthorizationError);
      expect(documents.createDocumentWithFirstVersion).not.toHaveBeenCalled();
    });
    it('fails only the item with an invalid intent; a sibling item with a valid intent still succeeds', async () => {
      documents.findUploadIntentByStorageKey.mockImplementation(async (key: string) =>
        key === 'good-key' ? validIntent({ storageKey: 'good-key' }) : null,
      );

      const result = await service.bulkCreateDocuments(
        BUILDING_ID,
        {
          documents: [
            {
              category: 'GENERAL',
              title: 'Good',
              fileUrl: 'good-key',
              fileName: 'lease.pdf',
              fileType: 'PDF',
              fileSize: 1024,
            },
            {
              category: 'GENERAL',
              title: 'Bad (unknown storage key)',
              fileUrl: 'bad-key',
              fileName: 'lease.pdf',
              fileType: 'PDF',
              fileSize: 1024,
            },
          ],
        } as never,
        ACTOR_ID,
        'req-1',
      );

      expect(result.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
      expect(result.results[0]).toEqual(expect.objectContaining({ status: 'created' }));
      expect(result.results[1]).toEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        }),
      );
    });
  });
});

describe('DocumentsService — FIN-REC-01B PAYMENT-reference inherited authorization (group 8: generic-document-bypass prevention)', () => {
  const RECEIPT_DOCUMENT = {
    id: 'doc-receipt-1',
    buildingId: 'building-1',
    visibility: 'MEMBERS_ONLY' as const,
    status: 'ACTIVE' as const,
  };
  const PAYMENT_ID = 'payment-1';

  let documents: Record<string, jest.Mock>;
  let finance: { getPaymentForViewer: jest.Mock };
  let service: DocumentsService;

  beforeEach(() => {
    documents = {
      findDocumentById: jest.fn().mockResolvedValue(RECEIPT_DOCUMENT),
      getCurrentVersion: jest.fn().mockResolvedValue({ id: 'version-1' }),
      listDocumentVersions: jest.fn().mockResolvedValue({ items: [{ id: 'version-1' }], total: 1 }),
      findVersionWithDocument: jest.fn().mockResolvedValue({
        id: 'version-1',
        documentId: RECEIPT_DOCUMENT.id,
        document: RECEIPT_DOCUMENT,
        fileUrl: 'payments/building-1/payment-1/secret-key.pdf',
        fileName: 'receipt.pdf',
        fileType: 'PDF',
      }),
      listCaseReferenceTargetsForDocument: jest.fn().mockResolvedValue([]),
      listPaymentReferenceTargetsForDocument: jest.fn().mockResolvedValue([PAYMENT_ID]),
      recordDownload: jest.fn().mockResolvedValue(undefined),
    };
    finance = { getPaymentForViewer: jest.fn() };
    service = new DocumentsService(
      documents as unknown as DocumentRepository,
      // A privileged-enough role for the generic MANAGEMENT_ONLY gate is
      // irrelevant here — the document's own visibility is MEMBERS_ONLY
      // (see `DocumentRepository.createPaymentReceipt`'s own comment on
      // why), so `buildings.getRoles` only needs to make `assertMember`
      // pass; the real narrowing gate under test is `getPaymentForViewer`.
      { getRoles: jest.fn().mockResolvedValue(['BOARD_MEMBER']) } as unknown as BuildingRepository,
      new DocumentPolicy(),
      { getCase: jest.fn() } as never,
      finance as unknown as FinanceService,
      { record: jest.fn() } as unknown as AuditService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {
        isConfigured: jest.fn().mockReturnValue(true),
        getPresignedDownloadUrl: jest.fn().mockReturnValue('https://signed'),
      } as unknown as StorageService,
    );
  });

  it('[8.1] a BOARD_MEMBER (privileged for generic MANAGEMENT_ONLY visibility) CANNOT fetch a receipt document via the generic getDocument(documentId) path', async () => {
    finance.getPaymentForViewer.mockRejectedValue(
      new AuthorizationError(
        'Only the payer or a Manager/Accountant of this building may access this payment receipt.',
      ),
    );

    await expect(service.getDocument(RECEIPT_DOCUMENT.id, 'board-member-1')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(finance.getPaymentForViewer).toHaveBeenCalledWith(
      RECEIPT_DOCUMENT.buildingId,
      PAYMENT_ID,
      'board-member-1',
    );
  });

  it('[8.2] a BOARD_MEMBER CANNOT list its versions via the generic version-list path', async () => {
    finance.getPaymentForViewer.mockRejectedValue(new AuthorizationError('denied'));

    await expect(
      service.listDocumentVersions(RECEIPT_DOCUMENT.id, 'board-member-1', { page: 1, limit: 20 }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(documents.listDocumentVersions).not.toHaveBeenCalled();
  });

  it('[8.3] a BOARD_MEMBER CANNOT get a presigned download via the generic downloadVersion path, even with a known/correct version id', async () => {
    finance.getPaymentForViewer.mockRejectedValue(new AuthorizationError('denied'));

    await expect(
      service.downloadVersion('version-1', 'board-member-1', 'req-1'),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(documents.recordDownload).not.toHaveBeenCalled();
  });

  it('[8.4] the payer/reviewer of that specific payment CAN still access the same document via getDocument/listDocumentVersions/downloadVersion — the new check narrows, it does not block everyone', async () => {
    finance.getPaymentForViewer.mockResolvedValue({
      id: PAYMENT_ID,
      buildingId: RECEIPT_DOCUMENT.buildingId,
      payerId: 'payer-1',
      method: 'BANK_TRANSFER',
    });

    await expect(service.getDocument(RECEIPT_DOCUMENT.id, 'payer-1')).resolves.toEqual(
      expect.objectContaining({ id: RECEIPT_DOCUMENT.id }),
    );
    await expect(
      service.listDocumentVersions(RECEIPT_DOCUMENT.id, 'payer-1', { page: 1, limit: 20 }),
    ).resolves.toEqual(expect.objectContaining({ items: [{ id: 'version-1' }] }));
    await expect(service.downloadVersion('version-1', 'payer-1', 'req-1')).resolves.toEqual(
      expect.objectContaining({ fileUrl: 'https://signed' }),
    );
    expect(documents.recordDownload).toHaveBeenCalledWith('version-1', 'payer-1');
  });

  it('a document with no PAYMENT reference at all is entirely unaffected (assertPaymentReferenceAccess is a no-op)', async () => {
    documents.listPaymentReferenceTargetsForDocument.mockResolvedValue([]);

    await expect(service.getDocument(RECEIPT_DOCUMENT.id, 'anyone-1')).resolves.toEqual(
      expect.objectContaining({ id: RECEIPT_DOCUMENT.id }),
    );
    expect(finance.getPaymentForViewer).not.toHaveBeenCalled();
  });
});

describe('DocumentsService — FIN-REC-01B generic-reference hardening (group 5)', () => {
  const document = {
    id: 'doc-1',
    buildingId: 'building-1',
    visibility: 'MEMBERS_ONLY' as const,
    status: 'ACTIVE' as const,
  };
  let documents: Record<string, jest.Mock>;
  let finance: { getPaymentForViewer: jest.Mock };
  let service: DocumentsService;

  beforeEach(() => {
    documents = {
      findDocumentById: jest.fn().mockResolvedValue(document),
      getCurrentVersion: jest.fn().mockResolvedValue({ id: 'version-1' }),
      findVersionWithDocument: jest.fn(),
      createReference: jest.fn().mockResolvedValue({ id: 'reference-1' }),
    };
    finance = { getPaymentForViewer: jest.fn() };
    service = new DocumentsService(
      documents as unknown as DocumentRepository,
      { getRoles: jest.fn().mockResolvedValue(['TENANT']) } as unknown as BuildingRepository,
      new DocumentPolicy(),
      { getCase: jest.fn().mockResolvedValue({ id: 'case-1' }) } as never,
      finance as unknown as FinanceService,
      { record: jest.fn() } as unknown as AuditService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { isConfigured: jest.fn().mockReturnValue(false) } as unknown as StorageService,
    );
  });

  it('[5.1] the generic createReference path CANNOT be used to attach an arbitrary entityType: PAYMENT reference — only the trusted finalize flow (DocumentRepository.createPaymentReceipt) can', async () => {
    await expect(
      service.createReference(
        'doc-1',
        { entityType: 'PAYMENT', entityId: 'payment-1' } as never,
        'person-1',
        'request-1',
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(documents.createReference).not.toHaveBeenCalled();
    expect(finance.getPaymentForViewer).not.toHaveBeenCalled();
  });

  it('[5.2] non-PAYMENT reference creation is completely unaffected (regression: CASE still works)', async () => {
    await service.createReference(
      'doc-1',
      { entityType: 'CASE', entityId: 'case-1' },
      'person-1',
      'request-1',
    );
    expect(documents.createReference).toHaveBeenCalledWith({
      documentVersionId: 'version-1',
      entityType: 'CASE',
      entityId: 'case-1',
    });
  });

  it('[5.2b] non-PAYMENT reference creation is unaffected for another existing type (VOTE)', async () => {
    await service.createReference(
      'doc-1',
      { entityType: 'VOTE', entityId: 'vote-1' },
      'person-1',
      'request-1',
    );
    expect(documents.createReference).toHaveBeenCalledWith({
      documentVersionId: 'version-1',
      entityType: 'VOTE',
      entityId: 'vote-1',
    });
  });
});
