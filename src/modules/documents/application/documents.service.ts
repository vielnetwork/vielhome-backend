import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  DocumentCategory,
  DocumentReferenceEntityType,
  DocumentStatus,
  DocumentVisibility,
  MembershipRole,
} from '@prisma/client';
import { DocumentRepository } from '../infrastructure/repositories/document.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { DocumentPolicy } from '../domain/policies/document.policy';
import { CreateDocumentDto } from './dto/create-document.dto';
import { BulkCreateDocumentDto } from './dto/bulk-create-document.dto';
import { UploadVersionDto } from './dto/upload-version.dto';
import { CreateReferenceDto } from './dto/create-reference.dto';
import { ArchiveDocumentDto } from './dto/archive-document.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { AppError, AuthorizationError, NotFoundAppError } from '../../../common/errors/app-error';
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

  async createDocument(buildingId: string, dto: CreateDocumentDto, actorPersonId: string, requestId: string) {
    await this.getBuilding(buildingId);
    await this.assertMember(actorPersonId, buildingId);

    const privileged = await this.isPrivileged(actorPersonId, buildingId);
    this.policy.assertCategoryManageable(dto.category, privileged);
    this.policy.assertFileTypeSupported(dto.fileType);

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

    this.events.emit('DocumentUploaded', new DocumentUploadedEvent(document.id, buildingId, actorPersonId, document.category));

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

        this.events.emit('DocumentUploaded', new DocumentUploadedEvent(document.id, buildingId, actorPersonId, document.category));

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

  /** 08.09 Rule 007: non-privileged callers never see MANAGEMENT_ONLY documents in the list. */
  async listDocuments(
    buildingId: string,
    actorPersonId: string,
    filter?: { category?: DocumentCategory; visibility?: DocumentVisibility; status?: DocumentStatus },
  ) {
    await this.assertMember(actorPersonId, buildingId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);

    const docs = await this.documents.listDocuments(buildingId, filter);
    return privileged ? docs : docs.filter((d) => d.visibility !== 'MANAGEMENT_ONLY');
  }

  async searchDocuments(
    buildingId: string,
    actorPersonId: string,
    params: { title?: string; category?: DocumentCategory; tags?: string[] },
  ) {
    await this.getBuilding(buildingId);
    await this.assertMember(actorPersonId, buildingId);
    const privileged = await this.isPrivileged(actorPersonId, buildingId);

    const docs = await this.documents.searchDocuments(buildingId, params);
    return privileged ? docs : docs.filter((d) => d.visibility !== 'MANAGEMENT_ONLY');
  }

  async getDocument(documentId: string, actorPersonId: string) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, found.buildingId);
    this.policy.assertVisible(found.visibility, privileged);

    const currentVersion = await this.documents.getCurrentVersion(documentId);
    return { ...found, currentVersion };
  }

  async uploadVersion(documentId: string, dto: UploadVersionDto, actorPersonId: string, requestId: string) {
    const found = await this.getDocumentOrThrow(documentId);
    await this.assertMember(actorPersonId, found.buildingId);
    const privileged = await this.isPrivileged(actorPersonId, found.buildingId);
    this.policy.assertCategoryManageable(found.category, privileged);
    this.policy.assertNotArchived(found.status);
    this.policy.assertFileTypeSupported(dto.fileType);

    const version = await this.documents.addVersion({
      documentId,
      uploadedById: actorPersonId,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: dto.fileSize,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
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

  async archiveDocument(documentId: string, dto: ArchiveDocumentDto, actorPersonId: string, requestId: string) {
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

    this.events.emit('DocumentArchived', new DocumentArchivedEvent(documentId, found.buildingId, actorPersonId));

    return updated;
  }

  async createReference(documentId: string, dto: CreateReferenceDto, actorPersonId: string, requestId: string) {
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

    return { fileUrl: version.fileUrl, fileName: version.fileName, fileType: version.fileType };
  }
}
