import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * Business rules for Governance/Meetings (04.06_Governance_Rules Rules
 * 11-13, 20 — see 21_ADRs > ADR-049). Never touches persistence
 * (11_Backend_Architecture > Domain Layer) — only asserts.
 */
@Injectable()
export class MeetingPolicy {
  /**
   * 04.06 Rule 13 "Meeting Minutes Must Be Preserved" — an archived
   * meeting's record is preserved as-is; no further update/attendance
   * recording is accepted, mirroring `DocumentPolicy.assertNotArchived`.
   */
  assertNotArchived(archivedAt: Date | null): void {
    if (archivedAt !== null) {
      throw new BusinessRuleViolationError('An archived meeting cannot be modified.');
    }
  }

  /** A meeting already archived cannot be archived again. */
  assertArchivable(archivedAt: Date | null): void {
    if (archivedAt !== null) {
      throw new BusinessRuleViolationError('This meeting is already archived.');
    }
  }
}
