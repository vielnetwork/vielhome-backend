import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * Business rules for Funds (12_Finance_Architecture > "Multiple Funds";
 * ADR-094, Sprint 29). Never touches persistence (11_Backend_Architecture >
 * Domain Layer) — only asserts.
 */
@Injectable()
export class FundPolicy {
  /**
   * The `isDefault` fund is the fallback every lazily-created charge/
   * payment flow relies on (`FinanceRepository.getOrCreateDefaultFund`) —
   * deactivating it would leave a building that has never explicitly
   * picked a fund with nowhere for new financial activity to land.
   */
  assertDeactivatable(isDefault: boolean): void {
    if (isDefault) {
      throw new BusinessRuleViolationError(
        'The default fund cannot be deactivated. Mark a different fund as default first.',
      );
    }
  }

  /** An inactive fund keeps its full history but cannot receive new activity. */
  assertActive(isActive: boolean): void {
    if (!isActive) {
      throw new BusinessRuleViolationError('This fund is deactivated and cannot be modified.');
    }
  }
}
