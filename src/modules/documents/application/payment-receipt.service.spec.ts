import { Prisma } from '@prisma/client';
import { PaymentReceiptService } from './payment-receipt.service';
import { DocumentRepository } from '../infrastructure/repositories/document.repository';
import { FinanceService } from '../../finance/application/finance.service';
import { StorageService } from '../../../common/storage/storage.service';
import { PaymentReceiptPolicy } from '../domain/policies/payment-receipt.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';

/**
 * FIN-REC-01B — `PaymentReceiptService` unit tests (65-item security test
 * matrix, groups 1-4 and 7). `DocumentRepository`/`FinanceService`/
 * `StorageService`/`AuditService` are fully mocked (no real DB, no real
 * object storage — see this session's own "Test Storage/DB Strategy"
 * writeup for why unit tests are the primary real-verification channel
 * in this sandbox). `PaymentReceiptPolicy` is a real, un-mocked instance
 * (no dependencies of its own), same discipline `DocumentPolicy`/
 * `PaymentPolicy` already get in `documents.service.spec.ts`/
 * `finance.service.spec.ts`.
 *
 * The full payer-or-finance-reviewer ROLE MATRIX (payer / same-building
 * MANAGER / same-building ACCOUNTANT / different-building MANAGER-or-
 * ACCOUNTANT / same-building BOARD_MEMBER / non-payer OWNER-or-TENANT /
 * no-membership) is exercised once, authoritatively, against the real
 * `FinanceService.getPaymentForViewer` implementation in
 * `finance.service.spec.ts` (describe block "getPaymentForViewer —
 * FIN-REC-01B payer-or-finance-reviewer authorization") — both the
 * upload-intent/finalize endpoints (group 1) and the download endpoint
 * (group 7) delegate to that exact method, so re-asserting the same
 * matrix a second time here against a mocked `getPaymentForViewer` would
 * only prove the mock does what it's told, not real authorization logic.
 * What THIS file verifies instead is the delegation/wiring itself (each
 * endpoint really does call `getPaymentForViewer(buildingId, paymentId,
 * actorPersonId)` and really does propagate its rejection) plus every
 * receipt-specific business rule layered on top: BANK_TRANSFER-only,
 * one-receipt-per-payment, file type/size policy, durable intent-to-
 * payment binding, magic-byte validation, atomic finalize, and the
 * storage-not-configured fail-closed download behavior.
 */
describe('PaymentReceiptService', () => {
  let documents: Record<string, jest.Mock>;
  let finance: { getPaymentForViewer: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let service: PaymentReceiptService;

  const BUILDING_ID = 'building-1';
  const PAYMENT_ID = 'payment-1';
  const ACTOR_ID = 'person-1';
  const STORAGE_KEY = 'payments/building-1/payment-1/abc123-receipt.pdf';
  const EXPIRES_SOON = new Date(Date.now() + 15 * 60 * 1000);

  const BANK_TRANSFER_PAYMENT = {
    id: PAYMENT_ID,
    buildingId: BUILDING_ID,
    payerId: ACTOR_ID,
    method: 'BANK_TRANSFER' as const,
    status: 'PENDING_APPROVAL' as const,
  };

  const CASH_PAYMENT = { ...BANK_TRANSFER_PAYMENT, method: 'CASH' as const };

  function validIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'intent-1',
      buildingId: BUILDING_ID,
      storageKey: STORAGE_KEY,
      requestedById: ACTOR_ID,
      purpose: 'PAYMENT_RECEIPT',
      documentId: null,
      paymentId: PAYMENT_ID,
      fileName: 'receipt.pdf',
      fileType: 'PDF',
      fileSize: 1024,
      createdAt: new Date(),
      expiresAt: EXPIRES_SOON,
      consumedAt: null,
      ...overrides,
    };
  }

  // Real magic-byte prefixes — see `common/storage/file-signature.ts`.
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const TEXT_BYTES = new Uint8Array(Buffer.from('Hello, this is not a real file!'));

  function p2002Error(): Prisma.PrismaClientKnownRequestError {
    const err = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
    err.code = 'P2002';
    err.message = 'Unique constraint failed';
    return err;
  }

  beforeEach(() => {
    documents = {
      findPaymentReceiptReference: jest.fn().mockResolvedValue(null),
      createUploadIntent: jest.fn().mockResolvedValue({ id: 'intent-1' }),
      findUploadIntentById: jest.fn().mockResolvedValue(validIntent()),
      createPaymentReceipt: jest.fn().mockResolvedValue({
        document: { id: 'doc-1' },
        version: {
          id: 'version-1',
          fileName: 'receipt.pdf',
          fileType: 'PDF',
          fileSize: 1024,
          uploadedAt: new Date('2026-08-27T00:00:00.000Z'),
        },
      }),
      recordDownload: jest.fn().mockResolvedValue(undefined),
    };
    finance = {
      getPaymentForViewer: jest.fn().mockResolvedValue(BANK_TRANSFER_PAYMENT),
    };
    storage = {
      buildPaymentReceiptObjectKey: jest.fn().mockReturnValue(STORAGE_KEY),
      getPresignedUploadUrl: jest.fn().mockReturnValue({
        uploadUrl: 'https://minio.local/bucket/' + STORAGE_KEY,
        storageKey: STORAGE_KEY,
        expiresAt: EXPIRES_SOON,
      }),
      getPresignedDownloadUrl: jest.fn().mockReturnValue('https://minio.local/signed-get'),
      readObjectPrefix: jest.fn().mockResolvedValue(PDF_BYTES),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn() };

    service = new PaymentReceiptService(
      documents as unknown as DocumentRepository,
      finance as unknown as FinanceService,
      storage as unknown as StorageService,
      new PaymentReceiptPolicy(),
      audit as unknown as AuditService,
    );
  });

  describe('requestUploadIntent — group 1 (upload-intent authorization)', () => {
    it('[1.wiring] delegates to FinanceService.getPaymentForViewer with (buildingId, paymentId, actorPersonId) and propagates its rejection untouched', async () => {
      finance.getPaymentForViewer.mockRejectedValue(
        new AuthorizationError(
          'Only the payer or a Manager/Accountant of this building may access this payment receipt.',
        ),
      );

      await expect(
        service.requestUploadIntent(
          BUILDING_ID,
          PAYMENT_ID,
          { fileName: 'r.pdf', fileType: 'PDF', fileSize: 100 },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);

      expect(finance.getPaymentForViewer).toHaveBeenCalledWith(BUILDING_ID, PAYMENT_ID, ACTOR_ID);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
      expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
    });

    it('[1.8] rejects a CASH-method payment with the stable BusinessRuleViolationError, never touching storage/intents', async () => {
      finance.getPaymentForViewer.mockResolvedValue(CASH_PAYMENT);

      await expect(
        service.requestUploadIntent(
          BUILDING_ID,
          PAYMENT_ID,
          { fileName: 'r.pdf', fileType: 'PDF', fileSize: 100 },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
      expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
    });

    it('[1.9] rejects with the stable ConflictError when this payment already has a finalized receipt, even at upload-intent stage', async () => {
      documents.findPaymentReceiptReference.mockResolvedValue({ id: 'ref-1' });

      await expect(
        service.requestUploadIntent(
          BUILDING_ID,
          PAYMENT_ID,
          { fileName: 'r.pdf', fileType: 'PDF', fileSize: 100 },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });

    it('[1.10] rejects an unsupported file type before ever building a storage key', async () => {
      await expect(
        service.requestUploadIntent(
          BUILDING_ID,
          PAYMENT_ID,
          { fileName: 'r.exe', fileType: 'EXE', fileSize: 100 },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(storage.buildPaymentReceiptObjectKey).not.toHaveBeenCalled();
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });

    it('[1.11] rejects a file larger than 25MB', async () => {
      await expect(
        service.requestUploadIntent(
          BUILDING_ID,
          PAYMENT_ID,
          { fileName: 'r.pdf', fileType: 'PDF', fileSize: 25 * 1024 * 1024 + 1 },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(documents.createUploadIntent).not.toHaveBeenCalled();
    });

    it('succeeds end-to-end for an authorized payer: builds a payment-scoped key, presigns, and persists a PAYMENT_RECEIPT intent bound to this payment', async () => {
      const result = await service.requestUploadIntent(
        BUILDING_ID,
        PAYMENT_ID,
        { fileName: 'r.pdf', fileType: 'PDF', fileSize: 100 },
        ACTOR_ID,
      );

      expect(storage.buildPaymentReceiptObjectKey).toHaveBeenCalledWith(
        BUILDING_ID,
        PAYMENT_ID,
        'r.pdf',
      );
      expect(documents.createUploadIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          buildingId: BUILDING_ID,
          storageKey: STORAGE_KEY,
          requestedById: ACTOR_ID,
          purpose: 'PAYMENT_RECEIPT',
          paymentId: PAYMENT_ID,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ uploadIntentId: 'intent-1', storageKey: STORAGE_KEY }),
      );
    });
  });

  describe('finalize — group 2 (durable binding)', () => {
    it('[2.1] cross-checks intent.paymentId against the URL :paymentId and rejects a mismatch with a stable not-found error', async () => {
      documents.findUploadIntentById.mockResolvedValue(
        validIntent({ paymentId: 'some-other-payment' }),
      );

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[2.2] a client cannot override the payment binding via the request body — only uploadIntentId is accepted, the URL :paymentId is the only binding input', async () => {
      documents.findUploadIntentById.mockResolvedValue(validIntent({ paymentId: PAYMENT_ID }));
      // A malicious/careless client tacking on an extra `paymentId` field in
      // the body (bypassing the DTO's own whitelist in a real HTTP request,
      // simulated here at the object level) must have zero effect — the
      // service reads the binding from the stored intent, never from `dto`.
      const dtoWithSmuggledField = {
        uploadIntentId: 'intent-1',
        paymentId: 'attacker-payment',
      } as never;

      await service.finalize(BUILDING_ID, PAYMENT_ID, dtoWithSmuggledField, ACTOR_ID, 'req-1');

      expect(documents.createPaymentReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: PAYMENT_ID }),
      );
    });

    it('[2.4] an intent created for one payment cannot be finalized against a different payment, even when the actor is independently authorized for both payments', async () => {
      const OTHER_PAYMENT_ID = 'payment-2';
      finance.getPaymentForViewer.mockImplementation(async (_b: string, paymentId: string) => ({
        ...BANK_TRANSFER_PAYMENT,
        id: paymentId,
      }));
      documents.findUploadIntentById.mockResolvedValue(validIntent({ paymentId: PAYMENT_ID }));

      await expect(
        service.finalize(
          BUILDING_ID,
          OTHER_PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[2.5] the intent must belong to the same building named in the URL', async () => {
      documents.findUploadIntentById.mockResolvedValue(
        validIntent({ buildingId: 'other-building', paymentId: PAYMENT_ID }),
      );

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });
  });

  describe('finalize — group 3 (magic-byte validation)', () => {
    it.each([
      ['PDF', PDF_BYTES],
      ['PNG', PNG_BYTES],
      ['JPEG', JPEG_BYTES],
    ])(
      '[3.valid-%s] accepts a real %s file whose bytes match its declared type',
      async (fileType, bytes) => {
        storage.readObjectPrefix.mockResolvedValue(bytes);
        documents.findUploadIntentById.mockResolvedValue(validIntent({ fileType }));

        await service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        );

        expect(documents.createPaymentReceipt).toHaveBeenCalled();
        expect(storage.deleteObject).not.toHaveBeenCalled();
      },
    );

    it.each(['PDF', 'JPG', 'PNG'])(
      '[3.renamed-%s] rejects a text file renamed .%s (real bytes do not match the declared type)',
      async (declaredType) => {
        storage.readObjectPrefix.mockResolvedValue(TEXT_BYTES);
        documents.findUploadIntentById.mockResolvedValue(validIntent({ fileType: declaredType }));

        await expect(
          service.finalize(
            BUILDING_ID,
            PAYMENT_ID,
            { uploadIntentId: 'intent-1' },
            ACTOR_ID,
            'req-1',
          ),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
      },
    );

    it('[3.truncated-empty] rejects an empty/too-short byte read (no signature can match)', async () => {
      storage.readObjectPrefix.mockResolvedValue(new Uint8Array(0));

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[3.truncated-readfailure] rejects with BusinessRuleViolationError when the object cannot be read back from storage at all', async () => {
      storage.readObjectPrefix.mockRejectedValue(new Error('network error'));

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[3.no-db-writes] on magic-byte rejection, no Document/DocumentVersion/DocumentReference row is created and the intent is never consumed', async () => {
      storage.readObjectPrefix.mockResolvedValue(TEXT_BYTES);

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toThrow();
      // createPaymentReceipt is the ONE method that both consumes the
      // intent and creates the Document/Version/Reference row, atomically
      // — asserting it was never called proves none of those four side
      // effects happened.
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it("[3.cleanup-called] on magic-byte rejection, StorageService.deleteObject is called with exactly the intent's own storage key", async () => {
      storage.readObjectPrefix.mockResolvedValue(TEXT_BYTES);

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toThrow();

      expect(storage.deleteObject).toHaveBeenCalledTimes(1);
      expect(storage.deleteObject).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('[3.cleanup-failure-hidden] a cleanup-delete failure still surfaces the original validation error, never the storage error, and never a silent success', async () => {
      storage.readObjectPrefix.mockResolvedValue(TEXT_BYTES);
      storage.deleteObject.mockRejectedValue(new Error('storage delete blew up'));

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });
  });

  describe('finalize — group 4 (finalize behavior)', () => {
    it('[4.1] happy path creates Document+DocumentVersion+DocumentReference(PAYMENT) and consumes the intent atomically, returning compact metadata', async () => {
      const result = await service.finalize(
        BUILDING_ID,
        PAYMENT_ID,
        { uploadIntentId: 'intent-1' },
        ACTOR_ID,
        'req-1',
      );

      expect(documents.createPaymentReceipt).toHaveBeenCalledWith({
        buildingId: BUILDING_ID,
        paymentId: PAYMENT_ID,
        createdById: ACTOR_ID,
        fileUrl: STORAGE_KEY,
        fileName: 'receipt.pdf',
        fileType: 'PDF',
        fileSize: 1024,
        uploadIntentId: 'intent-1',
      });
      expect(result).toEqual({
        id: 'doc-1',
        filename: 'receipt.pdf',
        contentType: 'PDF',
        size: 1024,
        createdAt: new Date('2026-08-27T00:00:00.000Z'),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PaymentReceiptFinalized', entityId: PAYMENT_ID }),
      );
    });

    it('[4.2] an expired intent is rejected with BusinessRuleViolationError and no DB records created', async () => {
      documents.findUploadIntentById.mockResolvedValue(
        validIntent({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[4.3] an already-consumed intent is rejected with ConflictError', async () => {
      documents.findUploadIntentById.mockResolvedValue(validIntent({ consumedAt: new Date() }));

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[4.4] a second finalize attempt after a prior successful one returns the same stable ConflictError, via the pre-check', async () => {
      documents.findPaymentReceiptReference.mockResolvedValue({ id: 'existing-reference' });

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(documents.findUploadIntentById).not.toHaveBeenCalled();
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('[4.5] a concurrent DB unique-constraint violation (P2002) on the reference creation is translated to the same stable ConflictError, not a raw 500', async () => {
      documents.createPaymentReceipt.mockRejectedValue(p2002Error());

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('[4.6] a CASH-method payment cannot be finalized even if a receipt intent somehow exists', async () => {
      finance.getPaymentForViewer.mockResolvedValue(CASH_PAYMENT);

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(documents.findUploadIntentById).not.toHaveBeenCalled();
      expect(documents.createPaymentReceipt).not.toHaveBeenCalled();
    });

    it('an unexpected (non-P2002) error from createPaymentReceipt propagates unchanged, not swallowed as a conflict', async () => {
      documents.createPaymentReceipt.mockRejectedValue(new Error('unexpected db outage'));

      await expect(
        service.finalize(
          BUILDING_ID,
          PAYMENT_ID,
          { uploadIntentId: 'intent-1' },
          ACTOR_ID,
          'req-1',
        ),
      ).rejects.toThrow('unexpected db outage');
    });
  });

  describe('download — group 7 (download-specific behavior beyond the shared authorization matrix)', () => {
    it('[7.wiring] delegates to FinanceService.getPaymentForViewer with (buildingId, paymentId, actorPersonId) and propagates its rejection untouched', async () => {
      finance.getPaymentForViewer.mockRejectedValue(new AuthorizationError('denied'));

      await expect(
        service.download(BUILDING_ID, PAYMENT_ID, ACTOR_ID, 'req-1'),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(finance.getPaymentForViewer).toHaveBeenCalledWith(BUILDING_ID, PAYMENT_ID, ACTOR_ID);
      expect(documents.recordDownload).not.toHaveBeenCalled();
    });

    it('[7.8] returns a stable NotFoundAppError (never a 500) when no receipt has been uploaded yet', async () => {
      documents.findPaymentReceiptReference.mockResolvedValue(null);

      await expect(
        service.download(BUILDING_ID, PAYMENT_ID, ACTOR_ID, 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(documents.recordDownload).not.toHaveBeenCalled();
    });

    it('[7.9] fails closed with the stable storage-not-configured error and never falls back to the raw stored fileUrl (deliberate deviation from generic Documents behavior)', async () => {
      const reference = {
        documentVersion: {
          id: 'version-1',
          fileUrl: STORAGE_KEY,
          fileName: 'r.pdf',
          fileType: 'PDF',
        },
      };
      documents.findPaymentReceiptReference.mockResolvedValue(reference);
      storage.getPresignedDownloadUrl.mockImplementation(() => {
        throw new Error(
          'Object storage is not configured on this server (STORAGE_ENDPOINT/STORAGE_BUCKET/STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY).',
        );
      });

      await expect(service.download(BUILDING_ID, PAYMENT_ID, ACTOR_ID, 'req-1')).rejects.toThrow(
        /storage is not configured/i,
      );
      // No fallback path exists here at all — unlike DocumentsService.downloadVersion,
      // this must never resolve successfully with the raw storage key/fileUrl.
      expect(documents.recordDownload).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('[7.10] a successful download records a DocumentDownload row and an audit log entry, and returns the presigned URL', async () => {
      const reference = {
        documentVersion: {
          id: 'version-1',
          fileUrl: STORAGE_KEY,
          fileName: 'r.pdf',
          fileType: 'PDF',
        },
      };
      documents.findPaymentReceiptReference.mockResolvedValue(reference);

      const result = await service.download(BUILDING_ID, PAYMENT_ID, ACTOR_ID, 'req-1');

      expect(documents.recordDownload).toHaveBeenCalledWith('version-1', ACTOR_ID);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PaymentReceiptDownloaded',
          entityType: 'DocumentVersion',
          entityId: 'version-1',
        }),
      );
      expect(result).toEqual({
        fileUrl: 'https://minio.local/signed-get',
        fileName: 'r.pdf',
        fileType: 'PDF',
      });
    });
  });
});
