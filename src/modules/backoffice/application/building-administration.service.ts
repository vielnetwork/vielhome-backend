import { Injectable } from '@nestjs/common';
import type { BuildingStatus } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { toCsv, DEFAULT_EXPORT_ROW_CAP } from '../../../common/csv/csv.util';

/**
 * 21_ADRs > ADR-112 — Building Administration (Stage 5). List/search/
 * detail are pure reads over `Building`; `lock`/`reinstate` are the two
 * direct staff actions, each wrapping the pre-existing `BuildingRepository
 * .updateBuildingStatus` (previously reachable only via the Building
 * Verification queue's own decide flow and `FraudCaseService`'s
 * VERIFICATION_REVOCATION enforcement effect) with a mandatory `reason`
 * and a dedicated audit action distinct from either of those workflows'
 * own trails (`BuildingVerificationDecided`/`EnforcementActionIssued`), so
 * an Audit Center reader can always tell which workflow actually caused a
 * given status change.
 *
 * Deliberately simple, matching `UserAdministrationService.suspend`/
 * `reinstate`'s own precedent: no guard against a concurrently-open
 * Building Verification Case or Fraud Case — this is a direct
 * administrative override, always applied and always audited, not a
 * workflow-aware transition. A building locked here while a verification
 * case is still open is a known, documented residual risk (see ADR-112),
 * not a gap this stage silently papers over.
 */
@Injectable()
export class BuildingAdministrationService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly buildings: BuildingRepository,
    private readonly audit: AuditService,
  ) {}

  async list(
    filters: { search?: string; status?: BuildingStatus; hasRecoveryMode?: boolean },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.searchBuildings(filters, toSkipTake(pagination));
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  /** 21_ADRs > ADR-115 — Reports & Export (Stage 8). Calls the exact
   * same `searchBuildings` query `list` already uses (same filters, no
   * new Prisma query), capped at `DEFAULT_EXPORT_ROW_CAP` rows instead
   * of paginated, and records a read-access audit event — same
   * precedent as `UserAdministrationService.exportCsv`. No `reason` —
   * export is a read, not a mutation. */
  async exportCsv(
    filters: { search?: string; status?: BuildingStatus; hasRecoveryMode?: boolean },
    actorPersonId: string,
    requestId: string,
  ): Promise<string> {
    const { items } = await this.backOffice.searchBuildings(filters, {
      skip: 0,
      take: DEFAULT_EXPORT_ROW_CAP,
    });

    await this.audit.record({
      actorId: actorPersonId,
      action: 'BuildingListExported',
      entityType: 'Building',
      entityId: 'search',
      requestId,
      metadata: { filters, rowCount: items.length },
    });

    return toCsv(items, [
      'id',
      'name',
      'status',
      'city',
      'district',
      'addressLine',
      'postalCode',
      'totalBlocks',
      'totalUnits',
      'recoveryModeEnteredAt',
      'createdAt',
    ]);
  }

  async getDetail(buildingId: string) {
    const building = await this.backOffice.getBuildingAdminDetail(buildingId);
    if (!building) {
      throw new NotFoundAppError('Building not found.');
    }
    return building;
  }

  /** Sets `Building.status` to `REJECTED` — the same status Building
   * Verification's own REJECT decision and Fraud Case's own
   * VERIFICATION_REVOCATION effect already use, reused here rather than
   * inventing a parallel "locked" concept the rest of the codebase
   * (governance-features-require-VERIFIED-manager gates, etc.) would not
   * otherwise recognize. */
  async lock(targetBuildingId: string, actorPersonId: string, reason: string, requestId: string) {
    const target = await this.backOffice.findBuildingForAdminStatusChange(targetBuildingId);
    if (!target) {
      throw new NotFoundAppError('Building not found.');
    }
    const previousValue = target.status;
    const updated = await this.buildings.updateBuildingStatus(targetBuildingId, 'REJECTED');

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: targetBuildingId,
      action: 'BuildingLockedByAdmin',
      entityType: 'Building',
      entityId: targetBuildingId,
      reason,
      metadata: { previousValue, newValue: updated.status },
      requestId,
    });

    return { buildingId: updated.id, status: updated.status };
  }

  /** Sets `Building.status` to `VERIFIED` — the same status Building
   * Verification's own APPROVE decision and Fraud Case's own
   * VERIFICATION_REVOCATION reversal effect already use. */
  async reinstate(
    targetBuildingId: string,
    actorPersonId: string,
    reason: string,
    requestId: string,
  ) {
    const target = await this.backOffice.findBuildingForAdminStatusChange(targetBuildingId);
    if (!target) {
      throw new NotFoundAppError('Building not found.');
    }
    const previousValue = target.status;
    const updated = await this.buildings.updateBuildingStatus(targetBuildingId, 'VERIFIED');

    await this.audit.record({
      actorId: actorPersonId,
      buildingId: targetBuildingId,
      action: 'BuildingReinstatedByAdmin',
      entityType: 'Building',
      entityId: targetBuildingId,
      reason,
      metadata: { previousValue, newValue: updated.status },
      requestId,
    });

    return { buildingId: updated.id, status: updated.status };
  }
}
