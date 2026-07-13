import { Injectable } from '@nestjs/common';
import {
  DocumentCategory,
  DocumentReferenceEntityType,
  DocumentStatus,
  DocumentVisibility,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

@Injectable()
export class DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a Document and its first (v1, current) DocumentVersion atomically — a document never exists without at least one version. */
  createDocumentWithFirstVersion(params: {
    buildingId: string;
    category: DocumentCategory;
    title: string;
    description?: string;
    tags?: string[];
    visibility: DocumentVisibility;
    createdById: string;
    fileUrl: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    expiresAt?: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          buildingId: params.buildingId,
          category: params.category,
          title: params.title,
          description: params.description,
          tags: params.tags ?? [],
          visibility: params.visibility,
          createdById: params.createdById,
        },
      });
      const version = await tx.documentVersion.create({
        data: {
          documentId: document.id,
          versionNumber: 1,
          fileUrl: params.fileUrl,
          fileName: params.fileName,
          fileType: params.fileType.toUpperCase(),
          fileSize: params.fileSize,
          uploadedById: params.createdById,
          isCurrent: true,
          expiresAt: params.expiresAt,
        },
      });
      return { document, version };
    });
  }

  findDocumentById(id: string) {
    return this.prisma.document.findUnique({ where: { id } });
  }

  findDocumentWithCurrentVersion(id: string) {
    return this.prisma.document.findUnique({
      where: { id },
      include: { versions: { where: { isCurrent: true }, take: 1 } },
    });
  }

  listDocuments(
    buildingId: string,
    filter?: {
      category?: DocumentCategory;
      visibility?: DocumentVisibility;
      status?: DocumentStatus;
    },
  ) {
    return this.prisma.document.findMany({
      where: {
        buildingId,
        ...(filter?.category ? { category: filter.category } : {}),
        ...(filter?.visibility ? { visibility: filter.visibility } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  searchDocuments(
    buildingId: string,
    params: { title?: string; category?: DocumentCategory; tags?: string[] },
  ) {
    return this.prisma.document.findMany({
      where: {
        buildingId,
        ...(params.title ? { title: { contains: params.title, mode: 'insensitive' } } : {}),
        ...(params.category ? { category: params.category } : {}),
        ...(params.tags && params.tags.length > 0 ? { tags: { hasSome: params.tags } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  getCurrentVersion(documentId: string) {
    return this.prisma.documentVersion.findFirst({ where: { documentId, isCurrent: true } });
  }

  findVersionWithDocument(versionId: string) {
    return this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      include: { document: true },
    });
  }

  /** 06.08 Rule 007: a new upload is always a new version, never an overwrite — unsets the previous current version in the same transaction. */
  addVersion(params: {
    documentId: string;
    uploadedById: string;
    fileUrl: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    expiresAt?: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.documentVersion.findFirst({
        where: { documentId: params.documentId },
        orderBy: { versionNumber: 'desc' },
      });
      const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

      await tx.documentVersion.updateMany({
        where: { documentId: params.documentId, isCurrent: true },
        data: { isCurrent: false },
      });

      return tx.documentVersion.create({
        data: {
          documentId: params.documentId,
          versionNumber: nextVersionNumber,
          fileUrl: params.fileUrl,
          fileName: params.fileName,
          fileType: params.fileType.toUpperCase(),
          fileSize: params.fileSize,
          uploadedById: params.uploadedById,
          isCurrent: true,
          expiresAt: params.expiresAt,
        },
      });
    });
  }

  archiveDocument(id: string) {
    return this.prisma.document.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  createReference(params: {
    documentVersionId: string;
    entityType: DocumentReferenceEntityType;
    entityId: string;
  }) {
    return this.prisma.documentReference.create({ data: params });
  }

  /** All documents attached to a given entity (e.g. every document referenced by a Case) — the mechanism ADR-025 deferred Case attachments to. */
  listReferencesForEntity(entityType: DocumentReferenceEntityType, entityId: string) {
    return this.prisma.documentReference.findMany({
      where: { entityType, entityId },
      include: { documentVersion: { include: { document: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  recordDownload(documentVersionId: string, downloadedById: string) {
    return this.prisma.documentDownload.create({ data: { documentVersionId, downloadedById } });
  }
}
