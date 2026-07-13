import { ChargePolicy } from './charge.policy';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

describe('ChargePolicy', () => {
  let policy: ChargePolicy;

  beforeEach(() => {
    policy = new ChargePolicy();
  });

  describe('assertValidCalculationInputs', () => {
    it('accepts a valid FIXED input', () => {
      expect(() => policy.assertValidCalculationInputs('FIXED', { amountPerUnit: 100_000 })).not.toThrow();
    });

    it('rejects FIXED with no amountPerUnit', () => {
      expect(() => policy.assertValidCalculationInputs('FIXED', {})).toThrow(BusinessRuleViolationError);
    });

    it('rejects FIXED with a zero amountPerUnit', () => {
      expect(() => policy.assertValidCalculationInputs('FIXED', { amountPerUnit: 0 })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('accepts a valid AREA_BASED input', () => {
      expect(() => policy.assertValidCalculationInputs('AREA_BASED', { ratePerSqm: 5_000 })).not.toThrow();
    });

    it('rejects AREA_BASED with no ratePerSqm', () => {
      expect(() => policy.assertValidCalculationInputs('AREA_BASED', {})).toThrow(BusinessRuleViolationError);
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
      expect(() => policy.assertCancellable('CANCELLED', false)).toThrow(BusinessRuleViolationError);
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
