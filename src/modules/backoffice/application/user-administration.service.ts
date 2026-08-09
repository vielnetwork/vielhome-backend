import { Injectable } from '@nestjs/common';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError, ValidationError } from '../../../common/errors/app-error';
import type { PaginationParams } from '../../../common/pagination/pagination.util';
import { buildPaginationMeta, toSkipTake } from '../../../common/pagination/pagination.util';
import { toCsv, DEFAULT_EXPORT_ROW_CAP } from '../../../common/csv/csv.util';

/**
 * 21_ADRs > ADR-111 — User Administration (Stage 4). List/search/detail
 * are pure reads over `Person`; `suspend`/`reinstate` are the two direct
 * staff actions, each delegating to an atomic `BackOfficeRepository`
 * transition (the underlying Person flag was previously reachable only via
 * `FraudCaseService`'s ACCOUNT_SUSPENSION enforcement effect — this gives
 * staff a direct path for a suspension that never originated from a
 * Fraud Case, e.g. a Support-initiated one) with a mandatory `reason` and
 * a dedicated audit action distinct from `FraudCaseService`'s own
 * `EnforcementActionIssued` trail, so an Audit Center reader can always
 * tell which workflow actually caused a given suspension.
 */
@Injectable()
export class UserAdministrationService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly audit: AuditService,
  ) {}

  async list(
    filters: { search?: string; isSuspended?: boolean; isBackofficeApproved?: boolean },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.searchPersons(filters, toSkipTake(pagination));
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  /** 21_ADRs > ADR-115 — Reports & Export (Stage 8). Calls the exact
   * same `searchPersons` query `list` already uses (same filters, no
   * new Prisma query), capped at `DEFAULT_EXPORT_ROW_CAP` rows instead
   * of paginated, and records a read-access audit event — the same
   * "sensitive bulk data access is itself auditable" precedent
   * `AuditController.export`'s own `AuditLogExported` action already
   * established, generalized here. No `reason` — export is a read, not
   * a mutation. */
  async exportCsv(
    filters: { search?: string; isSuspended?: boolean; isBackofficeApproved?: boolean },
    actorPersonId: string,
    requestId: string,
  ): Promise<string> {
    const { items } = await this.backOffice.searchPersons(filters, {
      skip: 0,
      take: DEFAULT_EXPORT_ROW_CAP,
    });

    await this.audit.record({
      actorId: actorPersonId,
      action: 'UserListExported',
      entityType: 'Person',
      entityId: 'search',
      requestId,
      metadata: { filters, rowCount: items.length },
    });

    return toCsv(items, [
      'id',
      'phone',
      'email',
      'fullName',
      'firstName',
      'lastName',
      'isSuspended',
      'isBackofficeApproved',
      'createdAt',
    ]);
  }

  async getDetail(personId: string) {
    const person = await this.backOffice.getPersonAdminDetail(personId);
    if (!person) {
      throw new NotFoundAppError('Person not found.');
    }
    return person;
  }

  /** Only an active Person may be suspended; repository CAS returns 409 for repeats/races. */
  async suspend(targetPersonId: string, actorPersonId: string, reason: string, requestId: string) {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new ValidationError('A non-empty reason is required.');
    return this.backOffice.changePersonSuspensionAtomically({
      targetPersonId,
      actorPersonId,
      suspend: true,
      reason: normalizedReason,
      requestId,
    });
  }

  async reinstate(
    targetPersonId: string,
    actorPersonId: string,
    reason: string,
    requestId: string,
  ) {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new ValidationError('A non-empty reason is required.');
    return this.backOffice.changePersonSuspensionAtomically({
      targetPersonId,
      actorPersonId,
      suspend: false,
      reason: normalizedReason,
      requestId,
    });
  }
}
