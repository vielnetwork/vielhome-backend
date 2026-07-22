import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ValidationError,
} from '../../../../common/errors/app-error';

/** 06.08 Rule 013: MVP-supported file types only. */
const SUPPORTED_FILE_TYPES = ['PDF', 'JPG', 'JPEG', 'PNG'] as const;

/**
 * 21_ADRs > ADR-087 — a disclosed, invented ceiling, not source-specified:
 * neither 06.08_Document_Flow nor 08.09_Document_API names a maximum file
 * size anywhere. 25MB comfortably covers this domain's own supported types
 * (a scanned multi-page PDF or a high-resolution photo of a document) while
 * still bounding the presigned-upload window's blast radius. Same category
 * of disclosed round-number choice as `BulkCreateDocumentDto`'s
 * `ArrayMaxSize(20)` (`ADR-051`).
 */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * 06.08 Rule 011/012 (reconciled — see the Documents schema-comment header
 * in `schema.prisma` for the full reconciliation note): upload/manage
 * rights for these categories require a privileged role
 * (MANAGER/BOARD_MEMBER/ACCOUNTANT); MAINTENANCE/GENERAL are open to any
 * current building member. This is the honest MVP collapse of the source
 * doc's finer "permission based, not only role based" model (Rule 004).
 */
const PRIVILEGED_CATEGORIES = ['GOVERNANCE', 'FINANCIAL', 'LEGAL'] as const;

/**
 * Business rules for Documents (06.08_Document_Flow, 08.09_Document_API —
 * see 21_ADRs > ADR-026). Never touches persistence (11_Backend_Architecture
 * > Domain Layer) — only asserts.
 */
@Injectable()
export class DocumentPolicy {
  assertFileTypeSupported(fileType: string): void {
    if (
      !SUPPORTED_FILE_TYPES.includes(
        fileType.toUpperCase() as (typeof SUPPORTED_FILE_TYPES)[number],
      )
    ) {
      throw new ValidationError(
        `Unsupported file type "${fileType}". Supported types: ${SUPPORTED_FILE_TYPES.join(', ')}.`,
      );
    }
  }

  /**
   * 21_ADRs > ADR-087 — checked both when a presigned upload URL is
   * requested (`DocumentsService.requestUploadUrl`) and again, in the same
   * "defense in depth" spirit `BuildingSetupService.submit()`'s own comment
   * uses elsewhere, when the resulting `Document`/`DocumentVersion` is
   * actually recorded (`createDocument`/`bulkCreateDocuments`/
   * `uploadVersion`) — the client-declared `fileSize` is trusted metadata
   * either way (see `StorageService.getPresignedUploadUrl`'s own doc
   * comment on that trust boundary), but bounding BOTH the declared size
   * at presign time and the recorded size at metadata-write time closes
   * off a client that skips the presign step and calls the metadata
   * endpoints directly with an oversized declared `fileSize`.
   */
  assertFileSizeWithinLimit(fileSize: number): void {
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      throw new ValidationError(
        `File is too large (${fileSize} bytes). Maximum allowed: ${MAX_FILE_SIZE_BYTES} bytes (25MB).`,
      );
    }
  }

  /** Gates create/version-upload/archive on a document's category. */
  assertCategoryManageable(category: string, isPrivileged: boolean): void {
    if (
      PRIVILEGED_CATEGORIES.includes(category as (typeof PRIVILEGED_CATEGORIES)[number]) &&
      !isPrivileged
    ) {
      throw new AuthorizationError(
        `Only a privileged role (MANAGER/BOARD_MEMBER/ACCOUNTANT) may manage ${category} documents.`,
      );
    }
  }

  /** 08.09 Rule 007: MANAGEMENT_ONLY documents are restricted; PUBLIC/MEMBERS_ONLY are open to any current member. */
  assertVisible(visibility: string, isPrivileged: boolean): void {
    if (visibility === 'MANAGEMENT_ONLY' && !isPrivileged) {
      throw new AuthorizationError('This document is restricted to management roles.');
    }
  }

  /** Flow doc Exception Cases: "Archived Document → Read-Only Access" — no new versions may be added. */
  assertNotArchived(status: string): void {
    if (status === 'ARCHIVED') {
      throw new BusinessRuleViolationError('This document is archived and is read-only.');
    }
  }

  assertArchivable(status: string): void {
    if (status === 'ARCHIVED') {
      throw new BusinessRuleViolationError('This document is already archived.');
    }
  }
}
