import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ValidationError,
} from '../../../../common/errors/app-error';

/** 06.08 Rule 013: MVP-supported file types only. */
const SUPPORTED_FILE_TYPES = ['PDF', 'JPG', 'JPEG', 'PNG'] as const;

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
