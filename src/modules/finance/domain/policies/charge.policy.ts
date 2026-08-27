import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

export interface ChargeBatchLike {
  status: string;
}

/**
 * Business rules for Charges (12_Finance_Architecture > "Charge Lifecycle",
 * reconciled from 10.08.01_Finance_Architecture). See the MVP simplification
 * note at the top of the Finance section in `schema.prisma` for why the
 * lifecycle here is DRAFT -> ISSUED -> CLOSED/CANCELLED rather than the
 * Frozen doc's full 7-stage lifecycle. Never touches persistence
 * (11_Backend_Architecture > Domain Layer) — only asserts.
 */
@Injectable()
export class ChargePolicy {
  assertValidClassification(input: {
    chargeKind?: string;
    seriesId?: string;
    periodStart?: string;
  }): void {
    if (!input.chargeKind) {
      if (input.seriesId !== undefined) {
        throw new BusinessRuleViolationError('seriesId requires an explicit chargeKind.');
      }
      return;
    }
    if (input.chargeKind === 'MONTHLY') {
      if (!input.seriesId) {
        throw new BusinessRuleViolationError('A MONTHLY charge requires seriesId.');
      }
      if (!input.periodStart) {
        throw new BusinessRuleViolationError('A MONTHLY charge requires periodStart.');
      }
      const date = new Date(input.periodStart);
      if (
        Number.isNaN(date.getTime()) ||
        date.getUTCDate() !== 1 ||
        date.getUTCHours() !== 0 ||
        date.getUTCMinutes() !== 0 ||
        date.getUTCSeconds() !== 0 ||
        date.getUTCMilliseconds() !== 0
      ) {
        throw new BusinessRuleViolationError(
          'periodStart must be the first day of the accounting month at 00:00:00.000Z.',
        );
      }
      return;
    }
    if (input.seriesId !== undefined || input.periodStart !== undefined) {
      throw new BusinessRuleViolationError(
        'seriesId and periodStart are only allowed for MONTHLY charges.',
      );
    }
  }

  /**
   * Exactly one calculation input set must be present, matching the
   * method.
   *
   * FIN-CALC-01 — FIXED and AREA_BASED each now accept EITHER the
   * preferred `totalAmount` (VielHome's real product model: the manager
   * enters one total, distributed across eligible units — see
   * `CreateChargeBatchDto.totalAmount`'s own doc comment) OR their legacy
   * per-unit field (`amountPerUnit`/`ratePerSqm`, kept only for the
   * currently-shipped Mobile client), but never both — an ambiguous
   * request naming two different totals is rejected outright, the same
   * "reject the contradiction, don't silently prefer one" posture already
   * established for MIXED + unitScope/unitIds below.
   */
  assertValidCalculationInputs(
    method: 'FIXED' | 'AREA_BASED' | 'MIXED',
    input: {
      amountPerUnit?: number;
      ratePerSqm?: number;
      totalAmount?: number;
      items?: Array<{ unitId: string; amount: number }>;
      unitScope?: string;
      unitIds?: string[];
    },
  ): void {
    // ADR-095 — MIXED's own `items[]` IS the unit selection; unitScope/
    // unitIds sent alongside it is a contradictory payload and must be
    // rejected outright, never silently ignored (see CreateChargeBatchDto's
    // own doc comment on `unitScope`).
    if (method === 'MIXED' && (input.unitScope !== undefined || input.unitIds !== undefined)) {
      throw new BusinessRuleViolationError(
        'unitScope/unitIds cannot be combined with MIXED — unit selection there comes from items.',
      );
    }
    // FIN-CALC-01 — likewise, MIXED's items[] already IS the explicit,
    // exact total; a `totalAmount` sent alongside it would be a second,
    // contradictory claim about the batch's total.
    if (method === 'MIXED' && input.totalAmount !== undefined) {
      throw new BusinessRuleViolationError(
        'totalAmount cannot be combined with MIXED — its items already specify the exact total.',
      );
    }

    if (method === 'FIXED') {
      const hasTotalAmount = input.totalAmount !== undefined;
      const hasLegacyAmount = input.amountPerUnit !== undefined;
      if (hasTotalAmount && hasLegacyAmount) {
        throw new BusinessRuleViolationError(
          'Send exactly one of totalAmount (preferred) or the legacy amountPerUnit for a FIXED charge batch, not both.',
        );
      }
      if (hasTotalAmount) {
        if (!input.totalAmount || input.totalAmount <= 0) {
          throw new BusinessRuleViolationError(
            'A FIXED charge batch requires a positive totalAmount.',
          );
        }
      } else if (!input.amountPerUnit || input.amountPerUnit <= 0) {
        throw new BusinessRuleViolationError(
          'A FIXED charge batch requires either a positive totalAmount or the legacy amountPerUnit.',
        );
      }
      this.assertValidUnitScopeInputs(input.unitScope, input.unitIds);
      return;
    }
    if (method === 'AREA_BASED') {
      const hasTotalAmount = input.totalAmount !== undefined;
      const hasLegacyRate = input.ratePerSqm !== undefined;
      if (hasTotalAmount && hasLegacyRate) {
        throw new BusinessRuleViolationError(
          'Send exactly one of totalAmount (preferred) or the legacy ratePerSqm for an AREA_BASED charge batch, not both.',
        );
      }
      if (hasTotalAmount) {
        if (!input.totalAmount || input.totalAmount <= 0) {
          throw new BusinessRuleViolationError(
            'An AREA_BASED charge batch requires a positive totalAmount.',
          );
        }
      } else if (!input.ratePerSqm || input.ratePerSqm <= 0) {
        throw new BusinessRuleViolationError(
          'An AREA_BASED charge batch requires either a positive totalAmount or the legacy ratePerSqm.',
        );
      }
      this.assertValidUnitScopeInputs(input.unitScope, input.unitIds);
      return;
    }
    // MIXED
    if (!input.items || input.items.length === 0) {
      throw new BusinessRuleViolationError(
        'A MIXED charge batch requires at least one explicit item.',
      );
    }
    if (input.items.some((i) => i.amount <= 0)) {
      throw new BusinessRuleViolationError('Every MIXED charge item amount must be positive.');
    }
  }

  /**
   * ADR-095 — shape-only checks for `unitScope`/`unitIds` that don't need
   * DB access (MANUAL requires a non-empty, duplicate-free unitIds array).
   * Whether each id actually belongs to the target building is checked in
   * `FinanceService.resolveChargeItems` instead, once the building's real
   * unit list is fetched — this policy stays persistence-free.
   */
  private assertValidUnitScopeInputs(
    unitScope: string | undefined,
    unitIds: string[] | undefined,
  ): void {
    if (unitScope !== 'MANUAL') return;
    if (!unitIds || unitIds.length === 0) {
      throw new BusinessRuleViolationError('unitScope MANUAL requires a non-empty unitIds array.');
    }
    if (new Set(unitIds).size !== unitIds.length) {
      throw new BusinessRuleViolationError('unitIds must not contain duplicates.');
    }
  }

  /**
   * ADR-095 — every MANUAL-scope unitId must actually belong to the
   * building being charged; called from the service once the building's
   * unit list has been fetched.
   */
  assertUnitsBelongToBuilding(unitIds: string[], validUnitIds: Set<string>): void {
    const invalid = unitIds.filter((id) => !validUnitIds.has(id));
    if (invalid.length > 0) {
      throw new BusinessRuleViolationError(
        `One or more selected units do not belong to this building: ${invalid.join(', ')}`,
      );
    }
  }

  /**
   * ADR-095 — a ChargeItem becomes late-fee eligible only once ALL of:
   * the batch is ISSUED, a late-fee policy exists on it, `dueDate +
   * graceDays` has passed, the item still has outstanding principal
   * (fully-settled items are never eligible), and no late fee has already
   * been applied to it (idempotency — checked by the caller via
   * `alreadyApplied`, sourced from `Adjustment.sourceType/sourceId`).
   * PERCENTAGE is always computed from the item's ORIGINAL `amount`, never
   * the current remaining balance — frozen semantics (ADR-095 Decision
   * point 3), so a partially-paid item's eligible fee doesn't shrink as
   * it's paid down.
   */
  computeLateFeeEligibility(params: {
    batchStatus: string;
    lateFeeType: string | null;
    lateFeeValue: number | null;
    lateFeeGraceDays: number | null;
    dueDate: Date | null;
    now: Date;
    itemAmount: number;
    itemPaidAmount: number;
    alreadyApplied: boolean;
  }): { eligible: boolean; amount: number } | null {
    if (params.batchStatus !== 'ISSUED') return null;
    if (!params.lateFeeType || !params.lateFeeValue) return null;
    if (!params.dueDate) return null;
    if (params.alreadyApplied) return null;

    const outstanding = params.itemAmount - params.itemPaidAmount;
    if (outstanding <= 0) return null;

    const graceDays = params.lateFeeGraceDays ?? 0;
    const eligibleFrom = new Date(params.dueDate);
    eligibleFrom.setDate(eligibleFrom.getDate() + graceDays);
    if (params.now < eligibleFrom) return null;

    const amount =
      params.lateFeeType === 'FIXED'
        ? params.lateFeeValue
        : Math.round((params.itemAmount * params.lateFeeValue) / 100);

    return { eligible: true, amount };
  }

  /** A batch cannot be issued twice, and an empty batch has nothing to collect. */
  assertIssuable(status: string, totalAmount: number): void {
    if (status !== 'DRAFT') {
      throw new BusinessRuleViolationError('Only a DRAFT charge batch can be issued.');
    }
    if (totalAmount <= 0) {
      throw new BusinessRuleViolationError('A charge batch with no charge items cannot be issued.');
    }
  }

  /**
   * A batch that already has money applied against it (any item partially
   * or fully paid) cannot be cancelled outright — Frozen Finance Rules
   * ("Payments never overwrite previous payments") means we never silently
   * unwind a payment by cancelling the charge it was allocated to. Refund
   * the payment first (future capability), or leave the batch CLOSED.
   */
  assertCancellable(status: string, hasAnyPaidAmount: boolean): void {
    if (status === 'CLOSED' || status === 'CANCELLED') {
      throw new BusinessRuleViolationError(`A ${status} charge batch cannot be cancelled again.`);
    }
    if (hasAnyPaidAmount) {
      throw new BusinessRuleViolationError(
        'This charge batch has payments already applied to it and cannot be cancelled.',
      );
    }
  }

  /**
   * An Adjustment (08.05 Rule 014 — see 21_ADRs > ADR-037) must actually
   * change something — a zero adjustment is neither a waiver nor an added
   * charge, just noise in the ledger.
   */
  assertValidAdjustmentAmount(amount: number): void {
    if (!amount || amount === 0) {
      throw new BusinessRuleViolationError('An adjustment amount must be non-zero.');
    }
  }
}
