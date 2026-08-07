import { Injectable } from '@nestjs/common';
import {
  DocumentCategory,
  DocumentReferenceEntityType,
  DocumentStatus,
  DocumentUploadPurpose,
  DocumentVisibility,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConflictError } from '../../../../common/errors/app-error';

@Injectable()
export class DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Documents Phase 1a Hardening (post-audit) — atomically consumes a
   * `DocumentUploadIntent` inside an already-open transaction, via a
   * conditional `updateMany` (`WHERE id = ? AND consumedAt IS NULL`)
   * rather than a plain `update`, so two concurrent requests racing to
   * consume the SAME intent can never both succeed: at most one
   * `updateMany` call affects a row (`count === 1`); the loser sees
   * `count === 0` and this throws `ConflictError`, rolling back the whole
   * transaction (the Document/DocumentVersion it would have created never
   * commits). `DocumentsService` is responsible for calling this only
   * AFTER intent validation (building/requester/purpose/document-binding/
   * metadata/expiry) and the real storage HEAD-object check have already
   * passed OUTSIDE this transaction — this method itself does no network
   * I/O, keeping the transaction itself short.
   */
  private async consumeUploadIntent(
    tx: Prisma.TransactionClient,
    uploadIntentId: string,
  ): Promise<void> {
    const consumed = await tx.documentUploadIntent.updateMany({
      where: { id: uploadIntentId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new ConflictError(
        'This upload intent has already been used (possibly by a concurrent request) or no longer exists.',
      );
    }
  }

  /**
   * Creates a Document and its first (v1, current) DocumentVersion
   * atomically — a document never exists without at least one version.
   *
   * `uploadIntentId` (Documents Phase 1a Hardening) — when storage is
   * configured, `DocumentsService.createDocument` has already validated
   * the caller's `DocumentUploadIntent` and verified the object exists in
   * storage (both OUTSIDE this transaction); passing its id here makes
   * consuming that intent and creating the Document a single atomic unit,
   * so an intent can never be left "validated but not consumed" by a
   * failure between the two. `undefined` when storage isn't configured
   * (pre-ADR-087 legacy path — no intent exists to consume).
   */
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
    uploadIntentId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      if (params.uploadIntentId) {
        await this.consumeUploadIntent(tx, params.uploadIntentId);
      }
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

  /**
   * Documents Phase 1a Hardening — persists the `DocumentUploadIntent` row
   * `DocumentsService.requestUploadUrl` creates the moment a presigned PUT
   * is issued. Plain `create`, no transaction needed — nothing else is
   * written alongside it at this point.
   */
  createUploadIntent(params: {
    buildingId: string;
    storageKey: string;
    requestedById: string;
    purpose: DocumentUploadPurpose;
    documentId?: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    expiresAt: Date;
  }) {
    return this.prisma.documentUploadIntent.create({ data: params });
  }

  /**
   * Documents Phase 1a Hardening — the read used to validate an intent
   * BEFORE any transaction opens (see `DocumentsService`'s own comment on
   * why storage network calls and this lookup both happen outside the
   * transaction that ultimately consumes the intent).
   */
  findUploadIntentByStorageKey(storageKey: string) {
    return this.prisma.documentUploadIntent.findUnique({ where: { storageKey } });
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

  /**
   * 21_ADRs > ADR-072/ADR-120 — Documents was one of the domains named in
   * the platform pagination re-audit as still returning an unbounded
   * array; this closes that gap for both `listDocuments`/`searchDocuments`.
   *
   * The MANAGEMENT_ONLY exclusion for a non-privileged caller used to
   * happen by filtering the *already-fetched* array in
   * `DocumentsService` (`docs.filter((d) => d.visibility !== 'MANAGEMENT_ONLY')`)
   * — correct for an unbounded list, but wrong once `skip`/`take` and a
   * `total` count are involved: filtering after the page is fetched can
   * return fewer than `limit` items even when more visible ones exist on
   * the same page boundary, and the unfiltered `total` would overcount
   * for a non-privileged caller. The exclusion now happens in the `WHERE`
   * clause itself, via `buildVisibilityCondition`, so both `findMany` and
   * `count` agree on exactly the same row set.
   */
  private buildVisibilityCondition(
    privileged: boolean,
    requestedVisibility?: DocumentVisibility,
  ): Prisma.DocumentWhereInput[] {
    const conditions: Prisma.DocumentWhereInput[] = [];
    if (requestedVisibility) conditions.push({ visibility: requestedVisibility });
    // A non-privileged caller who explicitly filters `visibility=MANAGEMENT_ONLY`
    // combines with this into an unsatisfiable AND (below) rather than leaking
    // those rows — an empty page, not a 403, matching this endpoint's existing
    // "silently omit, don't error" visibility posture (08.09 Rule 007).
    if (!privileged) conditions.push({ visibility: { not: 'MANAGEMENT_ONLY' } });
    return conditions;
  }

  async listDocuments(
    buildingId: string,
    filter: {
      category?: DocumentCategory;
      visibility?: DocumentVisibility;
      status?: DocumentStatus;
    },
    privileged: boolean,
    pagination: { skip: number; take: number },
  ) {
    const where: Prisma.DocumentWhereInput = {
      buildingId,
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      AND: this.buildVisibilityCondition(privileged, filter.visibility),
    };
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        // Two-key order: `createdAt` alone is not unique (rows created in
        // the same millisecond — e.g. a bulk upload — tie), which makes
        // `skip`/`take` pagination non-deterministic. `id` (cuid,
        // effectively monotonically increasing) is a stable tiebreaker.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.document.count({ where }),
    ]);
    return { items, total };
  }

  async searchDocuments(
    buildingId: string,
    params: { title?: string; category?: DocumentCategory; tags?: string[] },
    privileged: boolean,
    pagination: { skip: number; take: number },
  ) {
    const where: Prisma.DocumentWhereInput = {
      buildingId,
      ...(params.title ? { title: { contains: params.title, mode: 'insensitive' } } : {}),
      ...(params.category ? { category: params.category } : {}),
      ...(params.tags && params.tags.length > 0 ? { tags: { hasSome: params.tags } } : {}),
      AND: this.buildVisibilityCondition(privileged),
    };
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        // Same deterministic tiebreaker as `listDocuments` — see that
        // method's comment.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.document.count({ where }),
    ]);
    return { items, total };
  }

  getCurrentVersion(documentId: string) {
    return this.prisma.documentVersion.findFirst({ where: { documentId, isCurrent: true } });
  }

  async listDocumentVersions(documentId: string, pagination: { skip: number; take: number }) {
    const where: Prisma.DocumentVersionWhereInput = { documentId };
    const [items, total] = await Promise.all([
      this.prisma.documentVersion.findMany({
        where,
        select: {
          id: true,
          documentId: true,
          versionNumber: true,
          fileName: true,
          fileType: true,
          fileSize: true,
          uploadedAt: true,
          isCurrent: true,
          expiresAt: true,
        },
        orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.documentVersion.count({ where }),
    ]);
    return { items, total };
  }

  findVersionWithDocument(versionId: string) {
    return this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      include: { document: true },
    });
  }

  /**
   * 06.08 Rule 007: a new upload is always a new version, never an
   * overwrite — unsets the previous current version in the same
   * transaction. `uploadIntentId` (Documents Phase 1a Hardening) — same
   * atomic consume-and-write treatment as `createDocumentWithFirstVersion`
   * above; see that method's own comment.
   */
  addVersion(params: {
    documentId: string;
    uploadedById: string;
    fileUrl: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    expiresAt?: Date;
    uploadIntentId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      if (params.uploadIntentId) {
        await this.consumeUploadIntent(tx, params.uploadIntentId);
      }
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

  async listCaseReferenceTargetsForDocument(documentId: string): Promise<string[]> {
    const references = await this.prisma.documentReference.findMany({
      where: {
        entityType: 'CASE',
        documentVersion: { documentId },
      },
      select: { entityId: true },
      distinct: ['entityId'],
    });
    return references.map((reference) => reference.entityId);
  }

  recordDownload(documentVersionId: string, downloadedById: string) {
    return this.prisma.documentDownload.create({ data: { documentVersionId, downloadedById } });
  }
}
