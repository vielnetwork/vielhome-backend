import { ChargePolicy } from './charge.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('ChargePolicy', () => {
  let policy: ChargePolicy;

  beforeEach(() => {
    policy = new ChargePolicy();
  });

  describe('assertValidCalculationInputs', () => {
    it('accepts a valid FIXED input', () => {
      expect(() =>
        policy.assertValidCalculationInputs('FIXED', { amountPerUnit: 100_000 }),
      ).not.toThrow();
    });

    it('rejects FIXED with no amountPerUnit', () => {
      expect(() => policy.assertValidCalculationInputs('FIXED', {})).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects FIXED with a zero amountPerUnit', () => {
      expect(() => policy.assertValidCalculationInputs('FIXED', { amountPerUnit: 0 })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('accepts a valid AREA_BASED input', () => {
      expect(() =>
        policy.assertValidCalculationInputs('AREA_BASED', { ratePerSqm: 5_000 }),
      ).not.toThrow();
    });

    it('rejects AREA_BASED with no ratePerSqm', () => {
      expect(() => policy.assertValidCalculationInputs('AREA_BASED', {})).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('accepts a valid MIXED input', () => {
      expect(() =>
        policy.assertValidCalculationInputs('MIXED', { items: [{ unitId: 'u1', amount: 10_000 }] }),
      ).not.toThrow();
    });

    it('rejects MIXED with no items', () => {
      expect(() => policy.assertValidCalculationInputs('MIXED', { items: [] })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects MIXED with a non-positive item amount', () => {
      expect(() =>
        policy.assertValidCalculationInputs('MIXED', { items: [{ unitId: 'u1', amount: 0 }] }),
      ).toThrow(BusinessRuleViolationError);
    });

    // ADR-095 (Sprint 29, Charge Generation Phase 2)
    it('accepts FIXED with unitScope ALL and no unitIds', () => {
      expect(() =>
        policy.assertValidCalculationInputs('FIXED', { amountPerUnit: 100_000, unitScope: 'ALL' }),
      ).not.toThrow();
    });

    it('accepts FIXED with unitScope MANUAL and a non-empty unitIds array', () => {
      expect(() =>
        policy.assertValidCalculationInputs('FIXED', {
          amountPerUnit: 100_000,
          unitScope: 'MANUAL',
          unitIds: ['u1', 'u2'],
        }),
      ).not.toThrow();
    });

    it('rejects unitScope MANUAL with no unitIds', () => {
      expect(() =>
        policy.assertValidCalculationInputs('FIXED', { amountPerUnit: 100_000, unitScope: 'MANUAL' }),
      ).toThrow(BusinessRuleViolationError);
    });

    it('rejects unitScope MANUAL with an empty unitIds array', () => {
      expect(() =>
        policy.assertValidCalculationInputs('FIXED', {
          amountPerUnit: 100_000,
          unitScope: 'MANUAL',
          unitIds: [],
        }),
      ).toThrow(BusinessRuleViolationError);
    });

    it('rejects unitScope MANUAL with duplicate unitIds', () => {
      expect(() =>
        policy.assertValidCalculationInputs('FIXED', {
          amountPerUnit: 100_000,
          unitScope: 'MANUAL',
          unitIds: ['u1', 'u1'],
        }),
      ).toThrow(BusinessRuleViolationError);
    });

    it('rejects MIXED combined with unitScope', () => {
      expect(() =>
        policy.assertValidCalculationInputs('MIXED', {
          items: [{ unitId: 'u1', amount: 10_000 }],
          unitScope: 'ALL',
        }),
      ).toThrow(BusinessRuleViolationError);
    });

    it('rejects MIXED combined with unitIds', () => {
      expect(() =>
        policy.assertValidCalculationInputs('MIXED', {
          items: [{ unitId: 'u1', amount: 10_000 }],
          unitIds: ['u1'],
        }),
      ).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertUnitsBelongToBuilding', () => {
    it('allows unitIds that are all present in the valid set', () => {
      expect(() =>
        policy.assertUnitsBelongToBuilding(['u1', 'u2'], new Set(['u1', 'u2', 'u3'])),
      ).not.toThrow();
    });

    it('rejects a unitId outside the building', () => {
      expect(() =>
        policy.assertUnitsBelongToBuilding(['u1', 'other-building-unit'], new Set(['u1', 'u2'])),
      ).toThrow(BusinessRuleViolationError);
    });
  });

  describe('computeLateFeeEligibility', () => {
    const base = {
      batchStatus: 'ISSUED',
      lateFeeType: 'FIXED',
      lateFeeValue: 20_000,
      lateFeeGraceDays: 3,
      dueDate: new Date('2026-01-01T00:00:00Z'),
      itemAmount: 500_000,
      itemPaidAmount: 0,
      alreadyApplied: false,
    };

    it('is null when the batch is not ISSUED', () => {
      expect(
        policy.computeLateFeeEligibility({ ...base, batchStatus: 'DRAFT', now: new Date('2026-02-01T00:00:00Z') }),
      ).toBeNull();
    });

    it('is null when no late-fee policy exists', () => {
      expect(
        policy.computeLateFeeEligibility({ ...base, lateFeeType: null, now: new Date('2026-02-01T00:00:00Z') }),
      ).toBeNull();
    });

    it('is null before dueDate + graceDays has passed', () => {
      expect(
        policy.computeLateFeeEligibility({ ...base, now: new Date('2026-01-02T00:00:00Z') }),
      ).toBeNull();
    });

    it('is eligible once dueDate + graceDays has passed, with outstanding principal', () => {
      const result = policy.computeLateFeeEligibility({ ...base, now: new Date('2026-01-05T00:00:00Z') });
      expect(result).toEqual({ eligible: true, amount: 20_000 });
    });

    it('is null once the item is fully settled', () => {
      expect(
        policy.computeLateFeeEligibility({
          ...base,
          itemPaidAmount: 500_000,
          now: new Date('2026-02-01T00:00:00Z'),
        }),
      ).toBeNull();
    });

    it('is null when a late fee was already applied', () => {
      expect(
        policy.computeLateFeeEligibility({
          ...base,
          alreadyApplied: true,
          now: new Date('2026-02-01T00:00:00Z'),
        }),
      ).toBeNull();
    });

    it('computes PERCENTAGE from the ORIGINAL amount, not the remaining balance', () => {
      const result = policy.computeLateFeeEligibility({
        ...base,
        lateFeeType: 'PERCENTAGE',
        lateFeeValue: 2,
        itemPaidAmount: 300_000, // partially paid — remaining balance is 200_000
        now: new Date('2026-02-01T00:00:00Z'),
      });
      // 2% of the ORIGINAL 500_000 = 10_000, NOT 2% of the 200_000 remaining.
      expect(result).toEqual({ eligible: true, amount: 10_000 });
    });
  });

  describe('assertIssuable', () => {
    it('allows a DRAFT batch with a positive total to be issued', () => {
      expect(() => policy.assertIssuable('DRAFT', 100_000)).not.toThrow();
    });

    it('rejects issuing a non-DRAFT batch', () => {
      expect(() => policy.assertIssuable('ISSUED', 100_000)).toThrow(BusinessRuleViolationError);
    });

    it('rejects issuing an empty batch', () => {
      expect(() => policy.assertIssuable('DRAFT', 0)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertCancellable', () => {
    it('allows cancelling a DRAFT batch with no payments applied', () => {
      expect(() => policy.assertCancellable('DRAFT', false)).not.toThrow();
    });

    it('allows cancelling an ISSUED batch with no payments applied', () => {
      expect(() => policy.assertCancellable('ISSUED', false)).not.toThrow();
    });

    it('rejects cancelling an already CLOSED batch', () => {
      expect(() => policy.assertCancellable('CLOSED', false)).toThrow(BusinessRuleViolationError);
    });

    it('rejects cancelling an already CANCELLED batch', () => {
      expect(() => policy.assertCancellable('CANCELLED', false)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rejects cancelling a batch with payments already applied', () => {
      expect(() => policy.assertCancellable('ISSUED', true)).toThrow(BusinessRuleViolationError);
    });
  });

  describe('assertValidAdjustmentAmount', () => {
    it('allows a positive adjustment amount', () => {
      expect(() => policy.assertValidAdjustmentAmount(50_000)).not.toThrow();
    });

    it('allows a negative adjustment amount', () => {
      expect(() => policy.assertValidAdjustmentAmount(-50_000)).not.toThrow();
    });

    it('rejects a zero adjustment amount', () => {
      expect(() => policy.assertValidAdjustmentAmount(0)).toThrow(BusinessRuleViolationError);
    });
  });
});
