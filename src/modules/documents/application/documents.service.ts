import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  DocumentCategory,
  DocumentReferenceEntityType,
  DocumentStatus,
  DocumentUploadPurpose,
  DocumentVisibility,
  MembershipRole,
} from '@prisma/client';
import { DocumentRepository } from '../infrastructure/repositories/document.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { DocumentPolicy } from '../domain/policies/document.policy';
import { CreateDocumentDto } from './dto/create-document.dto';
import { BulkCreateDocumentDto } from './dto/bulk-create-document.dto';
import { UploadVersionDto } from './dto/upload-version.dto';
import { RequestUploadUrlDto } from './dto/request-upload-url.dto';
import { CreateReferenceDto } from './dto/create-reference.dto';
import { ArchiveDocumentDto } from './dto/archive-document.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import {
  AppError,
  AuthorizationError,
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import {
  DocumentArchivedEvent,
  DocumentReferenceCreatedEvent,
  DocumentUploadedEvent,
  DocumentVersionCreatedEvent,
} from '../events/document.events';

/** 08.09 Rule 008's "management" tier and 06.08 Rule 011's category-gated upload both key off this same set — reused from Cases/Finance/Governance. */
const PRIVILEGED_ROLES: MembershipRole[] = ['MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT'];

@Injectable()
export class DocumentsService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly buildings: BuildingRepository,
    private readonly policy: DocumentPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly storage: StorageService,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  private async isPrivileged(personId: string, buildingId: string): Promise<boolean> {
    const roles = await this.buildings.getRoles(personId, buildingId);
    return roles.some((role) => PRIVILEGED_ROLES.includes(role));
  }

  /**
   * `/documents/:documentId` and `/document-versions/:versionId` routes
   * carry no `:id` building param, so `MembershipGuard` can't apply there
   * (it reads `req.params.id` — see its own doc comment). This is that
   * same "any current member" check, done inline once the building is
   * known from the fetched Document/DocumentVersion row — the same
   * deviation-from-guard pattern CasesService already uses for
   * visibility checks beyond guard-level membership.
   */
  private async assertMember(personId: string, buildingId: string): Promise<void> {
    const roles = await this.buildings.getRoles(personId, buildingId);
    if (roles.length === 0) {
      throw new AuthorizationError('You do not have access to this building.');
    }
  }

  private async getDocumentOrThrow(documentId: string) {
    const found = await this.documents.findDocumentById(documentId);
    if (!found) throw new NotFoundAppError('Document not found.');
    return found;
  }

  /**
   * 21_ADRs > ADR-087 — step one of the real-storage upload flow: the
   * client requests a presigned PUT URL here, uploads the file bytes
   * directly to storage, then calls `createDocument`/`uploadVersion` with
   * the returned `storageKey` as `fileUrl`. Membership is checked (this is
   * a building-scoped action, same as `createDocument`) but NOT category
   * privilege — category isn't known until the create/upload-version call
   * itself, and gating on it here would mean asking the client to declare
   * a category twice.
   *
   * Documents Phase 1a Hardening (post-audit) — this now also persists a
   * `DocumentUploadIntent` row (only once the presign itself succeeds, so
   * the pre-existing "storage not configured" `UnexpectedAppError` is
   * unchanged — see the `if (!this.storage.isConfigured())` short-circuit
   * below) and returns its id as `uploadIntentId`. This is what closes the
   * trust boundary the audit flagged: `createDocument`/`uploadVersion`
   * will refuse to accept a `fileUrl` that doesn't match a real, unconsumed
   * intent once storage is configured — see those methods' own comments.
   *
   * For a `CREATE_VERSION` intent, the target Document is looked up and
   * confirmed to belong to THIS building before any intent is created —
   * closes off a caller requesting an intent (scoped to a building they
   * belong to) against a Document that actually lives in a different
   * building.
   */
  async requestUploadUrl(buildingId: string, dto: RequestUploadUrlDto, actorPersonId: string) {
    await this.getBuilding(buildingId);
    await this.assertMember(actorPersonId, buildingId);
    this.policy.assertFileTypeSupported(dto.fileType);
    this.policy.assertFileSizeWithinLimit(dto.fileSize);

    if (dto.purpose === 'CREATE_VERSION') {
      if (!dto.documentId) {
        throw new ValidationError('documentId is required when purpose is CREATE_VERSION.');
      }
      const target = await this.documents.findDocumentById(dto.documentId);
      if (!target || target.buildingId !== buildingId) {
        throw new NotFoundAppError('Document not found in this building.');
      }
    } else if (dto.purpose === 'CREATE_DOCUMENT' && dto.documentId) {
      // A CREATE_DOCUMENT intent has nothing to bind documentId to — it
      // exists precisely because the Document doesn't exist yet. Rejecting
      // this here (rather than silently ignoring the field) keeps the
      // contract explicit and prevents a caller from believing an
      // unrelated documentId was recorded against this intent.
      throw new ValidationError('documentId must not be provided when purpose is CREATE_DOCUMENT.');
    }

    const storageKey = this.storage.buildObjectKey(buildingId, dto.fileName);
    // Legacy behavior preserved exactly: when storage isn't configured,
    // this throws UnexpectedAppError here and no DocumentUploadIntent row
    // is ever created — same failure this endpoint has always had.
    const presigned = this.storage.getPresignedUploadUrl(storageKey);

    const intent = await this.documents.createUploadIntent({
      buildingId,
      storageKey,
      requestedById: actorPersonId,
      purpose: dto.purpose,
      documentId: dto.purpose === 'CREATE_VERSION' ? dto.documentId : undefined,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
      expiresAt: presigned.expiresAt,
    });

    return { ...presigned, uploadIntentId: intent.id };
  }

  /**
   * Documents Phase 1a Hardening (post-audit) — the storageKey
   * trust-boundary closure. Called by `createDocument`/`uploadVersion`/
   * `bulkCreateDocuments` immediately before they'd otherwise trust
   * `dto.fileUrl` as-is. Returns `undefined` (nothing to consume) when
   * storage isn't configured — the exact pre-ADR-087 legacy behavior,
   * unchanged: an unconfigured server has no presigned-upload flow and
   * therefore no intents to validate against, so `dto.fileUrl` stays a
   * trusted, opaque, client-supplied string exactly as before this pass.
   *
   * When storage IS configured, `dto.fileUrl` is required to be a
   * `storageKey` that matches a real, unconsumed `DocumentUploadIntent` —
   * an arbitrary/unknown string is rejected (`NotFoundAppError`), closing
   * the gap the audit flagged. Sequencing matters here and is deliberate:
   *  1. Look up the intent by storageKey (fast, no network) and validate
   *     every field against the caller's actual request — building,
   *     requester, purpose, document-binding (CREATE_VERSION only),
   *     expiry, consumption state, and declared file metadata.
   *  2. Only if all of that passes, issue a REAL presigned HEAD Object
   *     request against storage (`StorageService.verifyObjectUploaded`) —
   *     the actual network I/O — to confirm the object was really
   *     uploaded and its size matches. This runs OUTSIDE any DB
   *     transaction, on purpose: a Prisma transaction holds a connection
   *     (and, depending on isolation level, locks) for its entire
   *     duration, and a storage HEAD request has no reason to be inside
   *     that window — see `DocumentRepository.createDocumentWithFirstVersion`'s
   *     own comment for what happens next (atomic consume+create).
   *
   * Disclosed race window: between this method validating+HEAD-verifying
   * the intent and the caller's subsequent atomic consume+create
   * transaction, another concurrent request could consume the SAME intent
   * first. This is not a silent gap — `DocumentRepository`'s conditional
   * `updateMany` (`WHERE consumedAt IS NULL`) means at most one of the two
   * concurrent callers' transactions actually succeeds; the loser gets a
   * `ConflictError` from the repository layer at consume time, not a
   * successful-looking response with silently-wrong data. Closing this
   * window completely would require holding the intent locked (e.g.
   * `SELECT ... FOR UPDATE`) across the storage network call itself,
   * which is exactly the "long-running transaction blocked on a network
   * call" pattern this design explicitly avoids per the instructions this
   * pass was scoped against.
   */
  private async resolveUploadIntent(params: {
    buildingId: string;
    actorPersonId: string;
    purpose: DocumentUploadPurpose;
    documentId?: string;
    storageKey: string;
    fileName: string;
    fileType: string;
    fileSize: number;
  }): Promise<string | undefined> {
    if (!this.storage.isConfigured()) return undefined;

    const intent = await this.documents.findUploadIntentByStorageKey(params.storageKey);
    if (!intent) {
      throw new NotFoundAppError(
        'No upload intent found for this storage key. Request a presigned upload URL first (POST .../documents/upload-url).',
      );
    }
    if (intent.consumedAt) {
      throw new ConflictError('This upload intent has already been used.');
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      throw new BusinessRuleViolationError(
        'This upload intent has expired. Request a new upload URL.',
      );
    }
    if (intent.buildingId !== params.buildingId) {
      throw new AuthorizationError('This upload intent does not belong to this building.');
    }
    if (intent.requestedById !== params.actorPersonId) {
      throw new AuthorizationError('This upload intent was not requested by you.');
    }
    if (intent.purpose !== params.purpose) {
      throw new BusinessRuleViolationError(
        `This upload intent was requested for ${intent.purpose}, not ${params.purpose}.`,
      );
    }
    if (params.purpose === 'CREATE_VERSION' && intent.documentId !== params.documentId) {
      throw new BusinessRuleViolationError('This upload intent is bound to a different document.');
    }
    if (
      intent.fileName !== params.fileName ||
      intent.fileType.toUpperCase() !== params.fileType.toUpperCase() ||
      intent.fileSize !== params.fileSize
    ) {
      throw new ValidationError(
        'Submitted file metadata does not match the upload intent requested for this storage key.',
      );
    }

    // Real object-existence verification (the audit's own repeated
    // caution: presign generation and DB metadata creation are NOT proof
    // the object was actually uploaded) — outside any DB transaction.
    const verification = await this.storage.verifyObjectUploaded(
      params.storageKey,
      params.fileSize,
    );
    if (!verification.exists) {
      throw new BusinessRuleViolationError(
        'The file has not been uploaded to storage yet. PUT it to the presigned uploadUrl before calling this endpoint.',
      );
    }
    if (verification.sizeMismatch) {
      throw new ValidationError(
        `Uploaded file size (${verification.actualSizeBytes} bytes) does not match the declared file size (${params.fileSize} bytes).`,
      );
    }

    return intent.id;
  }

  async createDocument(
    buildingId: string,
    dto: CreateDocumentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);
    await this.assertMember(actorPersonId, buildingId);

    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    this.policy.assertCategoryManageable(dto.category, privileged);
    this.policy.assertFileTypeSupported(dto.fileType);
    this.policy.assertFileSizeWithinLimit(dto.fileSize);

    // Documents Phase 1a Hardening — when storage is configured, dto.fileUrl
    // must be a storageKey backed by a real, unconsumed CREATE_DOCUMENT
    // intent (validated + HEAD-verified here); undefined when storage isn't
    // configured, preserving the exact pre-ADR-087 legacy behavior.
    const uploadIntentId = await this.resolveUploadIntent({
      buildingId,
      actorPersonId,
      purpose: 'CREATE_DOCUMENT',
      storageKey: dto.fileUrl,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
    });

    const { document, version } = await this.documents.createDocumentWithFirstVersion({
      buildingId,
      category: dto.category,
      title: dto.title,
      description: dto.description,
      tags: dto.tags,
      visibility: dto.visibility ?? 'MEMBERS_ONLY',
      createdById: actorPersonId,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      uploadIntentId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'DocumentUploaded',
      entityType: 'Document',
      entityId: document.id,
      requestId,
      metadata: { category: document.category, versionId: version.id },
    });

    this.events.emit(
      'DocumentUploaded',
      new DocumentUploadedEvent(document.id, buildingId, actorPersonId, document.category),
    );

    return { document, version };
  }

  /**
   * 08.09 Rule 018 "Documents Support Bulk Upload" (21_ADRs > ADR-051).
   * Building membership/privilege is resolved once, up front, since it
   * doesn't vary per item; each item then runs the exact same
   * category/file-type policy checks and repository call `createDocument`
   * uses, so a bulk upload behaves identically to N sequential single
   * uploads — just batched into one request and one summary audit record.
   *
   * Partial-failure semantics (undisclosed by the source rule): item-level
   * atomicity, batch-level best-effort — one item's failure (bad category,
   * unsupported file type) is captured in that item's own `results[]`
   * entry and does NOT roll back or block any other item. There is no
   * source rule asking for all-or-nothing batch behavior, and requiring it
   * would mean one bad row in a 20-document upload silently discarding 19
   * good ones — the more defensible default absent a specified rule.
   *
   * Documents Phase 1a Hardening (post-audit, Section F decision) — when
   * storage is configured, each item's `fileUrl` is validated against its
   * OWN `DocumentUploadIntent` (via the same `resolveUploadIntent` used by
   * `createDocument`), one presigned upload-url request per file, exactly
   * as a client would do for N sequential single uploads. The alternative
   * considered was rejecting bulk upload outright whenever storage is
   * configured — deliberately NOT chosen: it would silently regress a
   * real, source-specified feature (08.09 Rule 018) the moment an operator
   * turns storage on, for no security benefit over per-item validation.
   * Per-item validation closes the exact same trust-boundary gap as the
   * single-document endpoint while preserving bulk upload's actual value.
   * A bad intent on one item fails only that item's own `results[]` entry
   * (the same partial-failure semantics already established above) — it
   * does not block or fail sibling items in the same batch.
   */
  async bulkCreateDocuments(
    buildingId: string,
    dto: BulkCreateDocumentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);
    await this.assertMember(actorPersonId, buildingId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);

    const results: Array<
      | { index: number; status: 'created'; document: unknown; version: unknown }
      | { index: number; status: 'failed'; error: { code: string; message: string } }
    > = [];

    for (let index = 0; index < dto.documents.length; index++) {
      const item = dto.documents[index];
      try {
        this.policy.assertCategoryManageable(item.category, privileged);
        this.policy.assertFileTypeSupported(item.fileType);
        this.policy.assertFileSizeWithinLimit(item.fileSize);

        const uploadIntentId = await this.resolveUploadIntent({
          buildingId,
          actorPersonId,
          purpose: 'CREATE_DOCUMENT',
          storageKey: item.fileUrl,
          fileName: item.fileName,
          fileType: item.fileType,
          fileSize: item.fileSize,
        });

        const { document, version } = await this.documents.createDocumentWithFirstVersion({
          buildingId,
          category: item.category,
          title: item.title,
          description: item.description,
          tags: item.tags,
          visibility: item.visibility ?? 'MEMBERS_ONLY',
          createdById: actorPersonId,
          fileUrl: item.fileUrl,
          fileName: item.fileName,
          fileType: item.fileType,
          fileSize: item.fileSize,
          expiresAt: item.expiresAt ? new Date(item.expiresAt) : undefined,
          uploadIntentId,
        });

        await this.audit.record({
          actorId: actorPersonId,
          buildingId,
          action: 'DocumentUploaded',
          entityType: 'Document',
          entityId: document.id,
          requestId,
          metadata: { category: document.category, versionId: version.id, bulkIndex: index },
        });

        this.events.emit(
          'DocumentUploaded',
          new DocumentUploadedEvent(document.id, buildingId, actorPersonId, document.category),
        );

        results.push({ index, status: 'created', document, version });
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'UNEXPECTED_ERROR';
        const message = err instanceof Error ? err.message : 'Unknown error.';
        results.push({ index, status: 'failed', error: { code, message } });
      }
    }

    const succeeded = results.filter((r) => r.status === 'created').length;
    const failed = results.length - succeeded;

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'DocumentBulkUploaded',
      entityType: 'Document',
      entityId: buildingId,
      requestId,
      metadata: { total: dto.documents.length, succeeded, failed },
    });

    return { results, summary: { total: dto.documents.length, succeeded, failed } };
  }

  /**
   * 08.09 Rule 007: non-privileged callers never see MANAGEMENT_ONLY
   * documents in the list. 21_ADRs > ADR-072/ADR-120 — `page`/`limit`
   * (Documents was a named gap in the platform pagination re-audit); the
   * MANAGEMENT_ONLY exclusion now happens inside
   * `DocumentRepository.listDocuments`'s own `WHERE` clause rather than
   * post-filtering the fetched page here — see that method's own doc
   * comment for why post-filtering and pagination don't mix safely.
   */
  async listDocuments(
    buildingId: string,
    actorPersonId: string,
    filter: {
      category?: DocumentCategory;
      visibility?: DocumentVisibility;
      status?: DocumentStatus;
    },
    pagination: PaginationParams,
  ) {
    await this.assertMember(actorPersonId, buildingId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);

    const { items, total } = await this.documents.listDocuments(
      buildingId,
      filter,
      privileged,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  /** Same pagination/visibility-in-WHERE treatment as `listDocuments` — see its own doc comment. */
  async searchDocuments(
    buildingId: string,
    actorPersonId: string,
    params: { title?: string; category?: DocumentCategory; tags?: string[] },
    pagination: PaginationParams,
  ) {
    await this.getBuilding(buildingId);
    await this.assertMember(actorPersonId, buildingId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);

    const { items, total } = await this.documents.searchDocuments(
      buildingId,
      params,
      privileged,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async getDocument(documentId: string, actorPersonId: string) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, found.buildingId);
    this.policy.assertVisible(found.visibility, privileged);

    const currentVersion = await this.documents.getCurrentVersion(documentId);
    return { ...found, currentVersion };
  }

  async listDocumentVersions(
    documentId: string,
    actorPersonId: string,
    pagination: PaginationParams,
  ) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, found.buildingId);
    this.policy.assertVisible(found.visibility, privileged);

    const { items, total } = await this.documents.listDocumentVersions(
      documentId,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async uploadVersion(
    documentId: string,
    dto: UploadVersionDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, found.buildingId);
    this.policy.assertCategoryManageable(found.category, privileged);
    this.policy.assertNotArchived(found.status);
    this.policy.assertFileTypeSupported(dto.fileType);
    this.policy.assertFileSizeWithinLimit(dto.fileSize);

    // Documents Phase 1a Hardening — a CREATE_VERSION intent must be bound
    // to THIS exact documentId (checked inside resolveUploadIntent), not
    // just any valid intent the same person happens to hold.
    const uploadIntentId = await this.resolveUploadIntent({
      buildingId: found.buildingId,
      actorPersonId,
      purpose: 'CREATE_VERSION',
      documentId,
      storageKey: dto.fileUrl,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
    });

    const version = await this.documents.addVersion({
      documentId,
      uploadedById: actorPersonId,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      uploadIntentId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: found.buildingId,
      action: 'DocumentVersionCreated',
      entityType: 'Document',
      entityId: documentId,
      requestId,
      metadata: { versionNumber: version.versionNumber },
    });

    this.events.emit(
      'DocumentVersionCreated',
      new DocumentVersionCreatedEvent(documentId, found.buildingId, version.id, actorPersonId),
    );

    return version;
  }

  async archiveDocument(
    documentId: string,
    dto: ArchiveDocumentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, found.buildingId);
    this.policy.assertCategoryManageable(found.category, privileged);
    this.policy.assertArchivable(found.status);

    const updated = await this.documents.archiveDocument(documentId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: found.buildingId,
      action: 'DocumentArchived',
      entityType: 'Document',
      entityId: documentId,
      requestId,
      reason: dto.reason,
    });

    this.events.emit(
      'DocumentArchived',
      new DocumentArchivedEvent(documentId, found.buildingId, actorPersonId),
    );

    return updated;
  }

  async createReference(
    documentId: string,
    dto: CreateReferenceDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);

    const versionId = dto.versionId ?? (await this.documents.getCurrentVersion(documentId))?.id;
    if (!versionId) throw new NotFoundAppError('This document has no version to reference.');

    const reference = await this.documents.createReference({
      documentVersionId: versionId,
      entityType: dto.entityType,
      entityId: dto.entityId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: found.buildingId,
      action: 'DocumentReferenceCreated',
      entityType: 'Document',
      entityId: documentId,
      requestId,
      metadata: { entityType: dto.entityType, entityId: dto.entityId, versionId },
    });

    this.events.emit(
      'DocumentReferenceCreated',
      new DocumentReferenceCreatedEvent(documentId, found.buildingId, dto.entityType, dto.entityId),
    );

    return reference;
  }

  /** Convenience lookup for "what documents are attached to this entity" — e.g. a Case's attachments (ADR-025's deferred item, closed here without any change to CasesModule). */
  async listReferencesForEntity(
    buildingId: string,
    entityType: DocumentReferenceEntityType,
    entityId: string,
    actorPersonId: string,
  ) {
    await this.assertMember(actorPersonId, buildingId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);

    const refs = await this.documents.listReferencesForEntity(entityType, entityId);
    return refs.filter((r) => {
      const doc = r.documentVersion.document;
      if (doc.buildingId !== buildingId) return false;
      return privileged || doc.visibility !== 'MANAGEMENT_ONLY';
    });
  }

  /**
   * 21_ADRs > ADR-087 — once real storage is configured
   * (`StorageService.isConfigured()`), the stored `fileUrl` is treated as
   * a storage key and a fresh, time-limited presigned GET is returned in
   * its place, instead of the raw stored value. This is a real,
   * intentional behavior change once an operator turns storage on: a
   * client relying on the pre-ADR-087 "returns whatever string I stored"
   * behavior would now get a signed URL wrapping that string as if it
   * were an object key. Not a concern for this MVP (no production data
   * predates this ADR — every prior `fileUrl` write was already this
   * codebase's own client-supplied-metadata stub), and disclosed here and
   * in this ADR's own Consequences rather than silently changed. When
   * storage is NOT configured, this returns exactly the pre-ADR-087
   * behavior (the raw stored value) — no regression for any environment
   * that hasn't provisioned real storage yet, including this sandbox's
   * own e2e test suite.
   */
  async downloadVersion(versionId: string, actorPersonId: string, requestId: string) {
    const version = await this.documents.findVersionWithDocument(versionId);
    if (!version) throw new NotFoundAppError('Document version not found.');

    await this.assertMember(actorPersonId, version.document.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, version.document.buildingId);
    this.policy.assertVisible(version.document.visibility, privileged);

    await this.documents.recordDownload(versionId, actorPersonId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: version.document.buildingId,
      action: 'DocumentDownloaded',
      entityType: 'DocumentVersion',
      entityId: versionId,
      requestId,
    });

    const fileUrl = this.storage.isConfigured()
      ? this.storage.getPresignedDownloadUrl(version.fileUrl)
      : version.fileUrl;

    return { fileUrl, fileName: version.fileName, fileType: version.fileType };
  }
}
