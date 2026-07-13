import { Injectable } from '@nestjs/common';
import type { TenancyStatus } from '@prisma/client';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

const OPEN_STATUSES: TenancyStatus[] = ['ACTIVE', 'NOTICE_GIVEN'];

/**
 * Pure business rules for Tenancy (10.07.03_Tenancy_v1.0 — see 21_ADRs >
 * ADR-035).
 */
@Injectable()
export class TenancyPolicy {
  /** Rule 003 — Only One Active Tenancy Per Unit (MVP). */
  assertUnitAvailableForTenancy(existingCurrentTenancy: { id: string } | null): void {
    if (existingCurrentTenancy) {
      throw new BusinessRuleViolationError('This unit already has an active tenancy.');
    }
  }

  /**
   * Rule 27/29 (04.02_Building_Rules) — a tenant is registered by the
   * unit's current owner or, softer language, the building's manager.
   * Neither doc says a tenant can register themselves.
   */
  assertCanCreate(isCallerCurrentOwnerOfUnit: boolean, callerIsManager: boolean): void {
    if (!isCallerCurrentOwnerOfUnit && !callerIsManager) {
      throw new AuthorizationError(
        "Only the unit's current owner or the building manager may register a tenancy.",
      );
    }
  }

  /**
   * Giving notice or ending a tenancy is allowed for the same owner/manager
   * pair as creating one, plus the tenant themselves — a tenant should be
   * able to end their own tenancy, unlike registering a new one.
   */
  assertCanManage(
    isCallerCurrentOwnerOfUnit: boolean,
    callerIsManager: boolean,
    isCallerTheTenant: boolean,
  ): void {
    if (!isCallerCurrentOwnerOfUnit && !callerIsManager && !isCallerTheTenant) {
      throw new AuthorizationError(
        "Only the unit's current owner, the building manager, or the tenant themselves may manage this tenancy.",
      );
    }
  }

  /** A notice can only be given on a still-ACTIVE tenancy. */
  assertCanGiveNotice(status: TenancyStatus): void {
    if (status !== 'ACTIVE') {
      throw new BusinessRuleViolationError(
        `Notice can only be given on an ACTIVE tenancy (current status: ${status}).`,
      );
    }
  }

  /** Rule 006 — a tenancy ends from ACTIVE or NOTICE_GIVEN; ENDED is terminal. */
  assertCanEnd(status: TenancyStatus): void {
    if (!OPEN_STATUSES.includes(status)) {
      throw new BusinessRuleViolationError(`Tenancy is already ended (status: ${status}).`);
    }
  }
}
