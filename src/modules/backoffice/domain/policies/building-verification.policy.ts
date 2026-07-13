import { Injectable } from '@nestjs/common';
import type { BuildingStatus } from '@prisma/client';
import { AuthorizationError, BusinessRuleViolationError } from '../../../../common/errors/app-error';

export interface BuildingRiskResult {
  score: number;
  flags: string[];
}

const DECIDABLE_STATUSES: BuildingStatus[] = ['PENDING', 'UNDER_REVIEW', 'PENDING_INFORMATION'];

/**
 * Pure business rules for the Building Verification Queue (07.01 — see
 * 21_ADRs > ADR-029). No persistence access, fully unit-testable.
 */
@Injectable()
export class BuildingVerificationPolicy {
  /**
   * 07.01 Rule 002 ("Every New Building Receives Risk Score"). The only
   * computable-today signal for this MVP is address similarity — see
   * `BuildingRepository.findSimilarAddressBuildings` and this policy's
   * own file header note on why "Known Fraud Patterns"/"Abnormal
   * Registration Activity" aren't scored here.
   */
  evaluateRisk(hasSimilarAddressBuilding: boolean): BuildingRiskResult {
    if (!hasSimilarAddressBuilding) {
      return { score: 0, flags: [] };
    }
    return { score: 50, flags: ['SIMILAR_ADDRESS_DIFFERENT_POSTAL_CODE'] };
  }

  /** 07.01 Rule 001/003 ("Auto First / Human Review Only For Exceptions"). Any positive risk score routes to manual review. */
  isAutoApproved(riskScore: number): boolean {
    return riskScore === 0;
  }

  /** 07.01 Rule 010's final-status set excludes further decisions on an already-decided case — VERIFIED/REJECTED/MERGED are terminal. */
  assertDecidable(status: BuildingStatus): void {
    if (!DECIDABLE_STATUSES.includes(status)) {
      throw new BusinessRuleViolationError(`Case is already decided (status: ${status}).`);
    }
  }

  /** 07.01 Rule 014: only a rejected building's own creator may appeal. */
  assertCanAppeal(status: BuildingStatus, callerPersonId: string, creatorId: string): void {
    if (status !== 'REJECTED') {
      throw new BusinessRuleViolationError('Only a rejected building may be appealed.');
    }
    if (callerPersonId !== creatorId) {
      throw new AuthorizationError('Only the building\'s creator may submit an appeal.');
    }
  }
}
