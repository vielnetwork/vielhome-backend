import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DocumentRepository } from '../infrastructure/repositories/document.repository';
import { PaymentReceiptPolicy } from '../domain/policies/payment-receipt.policy';
import { FinanceService } from '../../finance/application/finance.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import {
  detectFileSignature,
  normalizeDeclaredFileType,
} from '../../../common/storage/file-signature';
import {
  AppError,
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import { RequestPaymentReceiptUploadIntentDto } from './dto/request-payment-receipt-upload-intent.dto';
import { FinalizePaymentReceiptDto } from './dto/finalize-payment-receipt.dto';

/** Same defensive per-module copy `finance.service.ts`/`voting.service.ts`/`gamification.repository.ts` each already keep — see any of those for the pattern this mirrors. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * FIN-REC-01B — secure payment-receipt upload/finalize/download.
 *
 * Lives in the Documents module (not Finance) because every durable write
 * here goes through `DocumentRepository`'s own Document/DocumentVersion/
 * DocumentReference transaction machinery, and `DocumentsModule` already
 * depends on it directly; `FinanceService` is injected the other direction
 * instead (Documents → Finance) so `FinanceModule` never needs to import
 * `DocumentsModule` — no circular module dependency, no `forwardRef`
 * needed (confirmed: `finance.module.ts`/`finance.service.ts` import
 * nothing from `modules/documents`).
 *
 * MVP: exactly one finalized receipt per Payment, enforced twice — once
 * here (pre-check, a fast "no" before any presigned URL/transaction) and
 * once by the DB partial unique index `document_references_payment_entityId_key`
 * (the real concurrency backstop; see `DocumentRepository.createPaymentReceipt`'s
 * own doc comment).
 */
@Injectable()
export class PaymentReceiptService {
  private readonly logger = new Logger(PaymentReceiptService.name);

  constructor(
    private readonly documents: DocumentRepository,
    private readonly finance: FinanceService,
    private readonly storage: StorageService,
    private readonly policy: PaymentReceiptPolicy,
    private readonly audit: AuditService,
  ) {}

  /**
   * Payer-or-finance-reviewer of THIS building (`FinanceService.getPaymentForViewer`)
   * plus the receipt-specific `method === BANK_TRANSFER` business rule —
   * receipts are optional and bank-transfer-only; a receipt operation
   * against a CASH payment fails with a stable, specific error rather than
   * silently allowing it or 500ing. Never touches Payment creation itself.
   */
  private async getBankTransferPaymentForActor(
    buildingId: string,
    paymentId: string,
    actorPersonId: string,
  ) {
    const payment = await this.finance.getPaymentForViewer(buildingId, paymentId, actorPersonId);
    if (payment.method !== 'BANK_TRANSFER') {
      throw new BusinessRuleViolationError(
        'Receipts can only be attached to BANK_TRANSFER payments.',
      );
    }
    return payment;
  }

  /** MVP one-receipt-per-payment pre-check — see class doc comment for the DB-level backstop. */
  private async assertNoExistingReceipt(paymentId: string): Promise<void> {
    const existing = await this.documents.findPaymentReceiptReference(paymentId);
    if (existing) {
      throw new ConflictError('A receipt has already been uploaded for this payment.');
    }
  }

  /**
   * Step 1 — request a presigned upload URL. No new upload-intent may be
   * issued once a receipt is already finalized for this payment (checked
   * here, not just at finalize), so a caller can't stockpile intents
   * against a payment that's already done.
   */
  async requestUploadIntent(
    buildingId: string,
    paymentId: string,
    dto: RequestPaymentReceiptUploadIntentDto,
    actorPersonId: string,
  ) {
    const payment = await this.getBankTransferPaymentForActor(buildingId, paymentId, actorPersonId);
    await this.assertNoExistingReceipt(payment.id);
    this.policy.assertFileTypeSupported(dto.fileType);
    this.policy.assertFileSizeWithinLimit(dto.fileSize);

    const storageKey = this.storage.buildPaymentReceiptObjectKey(
      buildingId,
      payment.id,
      dto.fileName,
    );
    // Same legacy-preserved behavior as the generic Documents flow: if
    // storage isn't configured, this throws UnexpectedAppError here and no
    // DocumentUploadIntent row is ever created.
    const presigned = this.storage.getPresignedUploadUrl(storageKey);

    const intent = await this.documents.createUploadIntent({
      buildingId,
      storageKey,
      requestedById: actorPersonId,
      purpose: 'PAYMENT_RECEIPT',
      paymentId: payment.id,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
      expiresAt: presigned.expiresAt,
    });

    return { ...presigned, uploadIntentId: intent.id };
  }

  /**
   * Loads and validates the upload intent named by the finalize request —
   * by `uploadIntentId`, NEVER by a client-supplied storage key or
   * paymentId-for-binding-purposes. The actual binding to a Payment comes
   * from `intent.paymentId` (loaded from the DB); this endpoint's own
   * `:paymentId` URL segment is cross-checked against it, and a mismatch
   * is a stable not-found/invalid-intent error, never "success on a
   * different payment." Unlike the generic `DocumentsService.resolveUploadIntent`,
   * this deliberately does NOT require `intent.requestedById === actorPersonId`
   * — the finalize-time authorization check is "payer or reviewer of this
   * payment" (already enforced by `getBankTransferPaymentForActor` before
   * this is called), which may legitimately be a different person/flow
   * than whoever requested the upload URL.
   */
  private async loadValidReceiptIntent(
    uploadIntentId: string,
    buildingId: string,
    paymentId: string,
  ) {
    const intent = await this.documents.findUploadIntentById(uploadIntentId);
    if (!intent || intent.purpose !== 'PAYMENT_RECEIPT' || intent.buildingId !== buildingId) {
      throw new NotFoundAppError('No matching receipt upload intent found.');
    }
    if (intent.paymentId !== paymentId) {
      throw new NotFoundAppError('This upload intent does not belong to this payment.');
    }
    if (intent.consumedAt) {
      throw new ConflictError('This upload intent has already been used.');
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      throw new BusinessRuleViolationError(
        'This upload intent has expired. Request a new upload URL.',
      );
    }
    return intent;
  }

  /**
   * REQUIRED magic-byte validation, using `StorageService.readObjectPrefix`
   * (reads real bytes via a ranged presigned GET) to catch a text file
   * renamed `.jpg`/`.png`/`.pdf`. Returns the `AppError` to throw rather
   * than throwing directly, so `finalize` can run the best-effort object
   * cleanup first — see that method's own comment on ordering.
   */
  private async validateMagicBytes(intent: {
    storageKey: string;
    fileType: string;
  }): Promise<AppError | null> {
    let prefix: Uint8Array;
    try {
      prefix = await this.storage.readObjectPrefix(intent.storageKey, 16);
    } catch {
      // Could not even read the object back (never uploaded, or a storage
      // read failure) — a genuine validation failure, not a magic-byte
      // mismatch specifically, so a distinct, clearer message.
      return new BusinessRuleViolationError(
        'The receipt file could not be read from storage. Upload it to the presigned URL before finalizing.',
      );
    }
    const declared = normalizeDeclaredFileType(intent.fileType);
    const detected = detectFileSignature(prefix);
    if (!declared || !detected || detected !== declared) {
      return new ValidationError(
        "The uploaded file's actual contents do not match its declared file type.",
      );
    }
    return null;
  }

  /** Best-effort cleanup of the exact object THIS intent generated — never a caller-supplied key. Never lets a cleanup failure hide the real validation error from the caller. */
  private async bestEffortDeleteObject(storageKey: string): Promise<void> {
    try {
      await this.storage.deleteObject(storageKey);
    } catch (err) {
      this.logger.warn(
        `Failed to clean up invalid payment-receipt object: ${err instanceof Error ? err.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Step 2 — finalize. Verifies: `purpose === 'PAYMENT_RECEIPT'`,
   * `consumedAt === null`, `expiresAt > now`, `intent.paymentId === :paymentId`,
   * the payment exists in this building, `method === 'BANK_TRANSFER'`, the
   * actor is payer-or-reviewer (re-checked here, not just at upload-intent
   * time), no receipt already exists, and — REQUIRED — the object's real
   * magic bytes match its declared type. On any validation failure: no
   * `Document`/`DocumentVersion`/`DocumentReference` row is created, the
   * intent is NOT marked consumed, and the invalid object is best-effort
   * deleted (a delete failure never hides the validation error). On
   * success: atomic `Document`+`DocumentVersion`+`DocumentReference` create
   * and intent consumption in one transaction
   * (`DocumentRepository.createPaymentReceipt`); a concurrent duplicate
   * finalize is caught via the DB partial unique index's `P2002` and
   * translated to the same stable conflict error the pre-check throws.
   */
  async finalize(
    buildingId: string,
    paymentId: string,
    dto: FinalizePaymentReceiptDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const payment = await this.getBankTransferPaymentForActor(buildingId, paymentId, actorPersonId);
    await this.assertNoExistingReceipt(payment.id);

    const intent = await this.loadValidReceiptIntent(dto.uploadIntentId, buildingId, payment.id);

    const validationError = await this.validateMagicBytes(intent);
    if (validationError) {
      await this.bestEffortDeleteObject(intent.storageKey);
      throw validationError;
    }

    try {
      const { document, version } = await this.documents.createPaymentReceipt({
        buildingId,
        paymentId: payment.id,
        createdById: actorPersonId,
        fileUrl: intent.storageKey,
        fileName: intent.fileName,
        fileType: intent.fileType,
        fileSize: intent.fileSize,
        uploadIntentId: intent.id,
      });

      await this.audit.record({
        actorId: actorPersonId,
        buildingId,
        action: 'PaymentReceiptFinalized',
        entityType: 'Payment',
        entityId: payment.id,
        requestId,
        metadata: { documentId: document.id, versionId: version.id },
      });

      return {
        id: document.id,
        filename: version.fileName,
        contentType: version.fileType,
        size: version.fileSize,
        createdAt: version.uploadedAt,
      };
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError('A receipt has already been uploaded for this payment.');
      }
      throw error;
    }
  }

  /**
   * Step 3 — download. Payer-or-reviewer only, same rule as upload-intent/
   * finalize (though not the BANK_TRANSFER-only creation gate — viewing an
   * existing receipt doesn't need to re-derive it, only its existence
   * matters here).
   *
   * Deliberate deviation from `DocumentsService.downloadVersion`'s
   * storage-disabled fallback (audit item 24, `FIN-REC-01B` design note):
   * a generic Document falls back to returning the raw stored `fileUrl`
   * string when storage isn't configured; doing that for a payment receipt
   * would mean trusting an unsigned, non-expiring value for a financial
   * document — a materially bigger risk than for a generic building
   * document. `StorageService.getPresignedDownloadUrl` already throws the
   * existing stable "storage not configured" `UnexpectedAppError` in that
   * case (`assertConfigured()`); this deliberately does NOT catch that and
   * fall back to `version.fileUrl` the way `downloadVersion` does.
   */
  async download(buildingId: string, paymentId: string, actorPersonId: string, requestId: string) {
    const payment = await this.finance.getPaymentForViewer(buildingId, paymentId, actorPersonId);

    const reference = await this.documents.findPaymentReceiptReference(payment.id);
    if (!reference) {
      throw new NotFoundAppError('No receipt has been uploaded for this payment yet.');
    }
    const version = reference.documentVersion;

    // Throws (fail closed) rather than falling back if storage isn't
    // configured — see this method's own doc comment above.
    const fileUrl = this.storage.getPresignedDownloadUrl(version.fileUrl);

    // Same download-audit pattern `DocumentsService.downloadVersion`
    // already uses (08.09 Rule 017 — download history is preserved).
    await this.documents.recordDownload(version.id, actorPersonId);
    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'PaymentReceiptDownloaded',
      entityType: 'DocumentVersion',
      entityId: version.id,
      requestId,
    });

    return { fileUrl, fileName: version.fileName, fileType: version.fileType };
  }
}
