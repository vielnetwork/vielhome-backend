import { EventEmitter2 } from '@nestjs/event-emitter';
import { FinanceService } from './finance.service';
import { FinanceRepository } from '../infrastructure/repositories/finance.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { ChargePolicy } from '../domain/policies/charge.policy';
import { PaymentPolicy } from '../domain/policies/payment.policy';
import { FundPolicy } from '../domain/policies/fund.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  BusinessRuleViolationError,
  DuplicateError,
  NotFoundAppError,
} from '../../../common/errors/app-error';

/**
 * Finance Hardening Pass (post-audit) — `FinanceService` unit tests.
 *
 * The audit's own §5/§9 finding: this service had zero unit-level
 * coverage before this pass — only the `domain/policies/*.spec.ts` (pure
 * logic, no I/O) and the full e2e suite ever exercised it. This file
 * fills that gap for the highest-risk orchestration paths named by the
 * hardening scope: explicit/default Fund resolution and the new
 * inactive-Fund rejection, Charge Batch create/preview orchestration,
 * payer-snapshot timing, allocation-adjacent delegation, reversal/refund
 * `options.auditAction` passthrough, event emission, and the new
 * pagination pass-through.
 *
 * `FinanceRepository`/`BuildingRepository`/`AuditService`/`EventEmitter2`
 * are fully mocked (I/O isolation, same discipline
 * `FinanceAdministrationService.spec.ts` already established for the
 * Backoffice layer). `ChargePolicy`/`PaymentPolicy`/`FundPolicy` are real,
 * un-mocked instances — they have no dependencies of their own, are
 * already exhaustively unit-tested in their own `*.spec.ts` files, and
 * using the real objects here proves the service actually wires their
 * real behavior end-to-end rather than re-asserting policy logic a
 * second time with a mock stand-in.
 */
describe('FinanceService', () => {
  let finance: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let service: FinanceService;

  const ACTIVE_FUND = { id: 'fund-1', buildingId: 'b1', isActive: true, isDefault: false };
  const INACTIVE_FUND = { id: 'fund-2', buildingId: 'b1', isActive: false, isDefault: false };
  const DEFAULT_FUND = { id: 'fund-default', buildingId: 'b1', isActive: true, isDefault: true };

  beforeEach(() => {
    finance = {
      findFundById: jest.fn(),
      getOrCreateDefaultFund: jest.fn(),
      findDefaultFund: jest.fn(),
      createFund: jest.fn(),
      listFunds: jest.fn(),
      updateFund: jest.fn(),
      setFundActive: jest.fn(),
      createChargeBatch: jest.fn(),
      listChargeBatches: jest.fn(),
      findChargeBatchById: jest.fn(),
      issueChargeBatch: jest.fn(),
      cancelChargeBatch: jest.fn(),
      hasAnyPaidChargeItems: jest.fn(),
      listChargeItemsByUnit: jest.fn(),
      findChargeItemById: jest.fn(),
      listLateFeeEligibleCandidates: jest.fn(),
      findAppliedLateFeeChargeItemIds: jest.fn().mockResolvedValue(new Set()),
      findAdjustmentBySource: jest.fn(),
      createAdjustment: jest.fn(),
      listAdjustmentsByUnit: jest.fn(),
      getUnitDebt: jest.fn(),
      getUnitOpeningBalanceCorrectionTotal: jest.fn(),
      applyOpeningBalanceCorrection: jest.fn(),
      createPayment: jest.fn(),
      listPayments: jest.fn(),
      listPaymentsByUnit: jest.fn(),
      findPaymentById: jest.fn(),
      approvePayment: jest.fn(),
      rejectPayment: jest.fn(),
      reversePayment: jest.fn(),
      refundPayment: jest.fn(),
      createRefund: jest.fn(),
      findRefundsByPayment: jest.fn().mockResolvedValue([]),
      listRefundsByPayment: jest.fn(),
      getFinancialSummary: jest.fn(),
      listLedger: jest.fn(),
      getCollectionRate: jest.fn(),
      getPaymentRegistrationRate: jest.fn(),
    };
    buildings = {
      findById: jest.fn().mockResolvedValue({ id: 'b1' }),
      listUnits: jest.fn().mockResolvedValue([]),
      findUnitById: jest.fn(),
      findCurrentTenancyForUnit: jest.fn().mockResolvedValue(null),
      getCurrentOwnerPersonIds: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };

    service = new FinanceService(
      finance as unknown as FinanceRepository,
      buildings as unknown as BuildingRepository,
      new ChargePolicy(),
      new PaymentPolicy(),
      new FundPolicy(),
      audit as unknown as AuditService,
      events as unknown as EventEmitter2,
    );
  });

  describe('resolveFundForWrite (via createChargeBatch/createPayment/createAdjustment)', () => {
    const chargeBatchDto = {
      title: 'Mehr charge',
      calculationMethod: 'FIXED' as const,
      amountPerUnit: 100_000,
    };

    it('resolves an explicit dto.fundId when it exists, belongs to the building, and is active', async () => {
      finance.findFundById.mockResolvedValue(ACTIVE_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { ...chargeBatchDto, fundId: 'fund-1' },
        'actor-1',
        'req-1',
      );

      expect(finance.findFundById).toHaveBeenCalledWith('fund-1');
      expect(finance.getOrCreateDefaultFund).not.toHaveBeenCalled();
      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({ fundId: 'fund-1' }),
      );
    });

    it('falls back to getOrCreateDefaultFund when dto.fundId is omitted', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch('b1', chargeBatchDto, 'actor-1', 'req-1');

      expect(finance.getOrCreateDefaultFund).toHaveBeenCalledWith('b1');
      expect(finance.findFundById).not.toHaveBeenCalled();
      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({ fundId: 'fund-default' }),
      );
    });

    it('rejects an explicit fundId pointing at a deactivated Fund with BusinessRuleViolationError, and never writes the ChargeBatch', async () => {
      finance.findFundById.mockResolvedValue(INACTIVE_FUND);

      await expect(
        service.createChargeBatch(
          'b1',
          { ...chargeBatchDto, fundId: 'fund-2' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createChargeBatch).not.toHaveBeenCalled();
    });

    it('rejects a fundId belonging to a different building as NotFoundAppError (not the inactive-fund message)', async () => {
      finance.findFundById.mockResolvedValue({ ...ACTIVE_FUND, buildingId: 'other-building' });

      await expect(
        service.createChargeBatch(
          'b1',
          { ...chargeBatchDto, fundId: 'fund-1' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundAppError);
    });

    it('createPayment rejects a deactivated explicit Fund and never reaches FinanceRepository.createPayment', async () => {
      finance.findFundById.mockResolvedValue(INACTIVE_FUND);
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });

      await expect(
        service.createPayment(
          'b1',
          'u1',
          { amount: 50_000, method: 'CASH', fundId: 'fund-2' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createPayment).not.toHaveBeenCalled();
    });

    it('createPayment succeeds against an explicit active Fund, defaulting isManualAmount to false', async () => {
      finance.findFundById.mockResolvedValue(ACTIVE_FUND);
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.createPayment.mockResolvedValue({ id: 'pay-1' });

      await service.createPayment(
        'b1',
        'u1',
        { amount: 50_000, method: 'CASH', fundId: 'fund-1' },
        'actor-1',
        'req-1',
      );

      expect(finance.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ fundId: 'fund-1', isManualAmount: false }),
      );
    });

    it('createPayment forwards an explicit isManualAmount: true through to FinanceRepository (Finance QA correction)', async () => {
      finance.findFundById.mockResolvedValue(ACTIVE_FUND);
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.createPayment.mockResolvedValue({ id: 'pay-1' });

      await service.createPayment(
        'b1',
        'u1',
        { amount: 50_000, method: 'CASH', fundId: 'fund-1', isManualAmount: true },
        'actor-1',
        'req-1',
      );

      expect(finance.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ isManualAmount: true }),
      );
    });

    it('propagates FinanceRepository.createPayment rejecting a manual-less amount that exceeds remaining payable', async () => {
      finance.findFundById.mockResolvedValue(ACTIVE_FUND);
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.createPayment.mockRejectedValue(
        new BusinessRuleViolationError("This amount exceeds the unit's remaining payable amount (0)."),
      );

      await expect(
        service.createPayment(
          'b1',
          'u1',
          { amount: 35_003_000, method: 'CASH', fundId: 'fund-1' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });

    it('createAdjustment rejects a deactivated explicit Fund and never reaches FinanceRepository.createAdjustment', async () => {
      finance.findFundById.mockResolvedValue(INACTIVE_FUND);
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });

      await expect(
        service.createAdjustment(
          'b1',
          'u1',
          { amount: -10_000, reason: 'waiver', fundId: 'fund-2' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createAdjustment).not.toHaveBeenCalled();
    });

    it('createAdjustment succeeds against the default Fund when fundId is omitted', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.createAdjustment.mockResolvedValue({ id: 'adj-1' });

      await service.createAdjustment(
        'b1',
        'u1',
        { amount: 20_000, reason: 'late fee' },
        'actor-1',
        'req-1',
      );

      expect(finance.createAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ fundId: 'fund-default' }),
      );
    });
  });

  describe('getUnitOpeningBalance', () => {
    it('returns the running sum of OPENING_BALANCE_CORRECTION adjustments as effectiveOpeningBalance', async () => {
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(300_000);

      const result = await service.getUnitOpeningBalance('b1', 'u1');

      expect(result).toEqual({ effectiveOpeningBalance: 300_000 });
      expect(finance.getUnitOpeningBalanceCorrectionTotal).toHaveBeenCalledWith('u1');
    });

    it('returns zero for a unit that has never had a correction applied', async () => {
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(0);

      const result = await service.getUnitOpeningBalance('b1', 'u1');

      expect(result).toEqual({ effectiveOpeningBalance: 0 });
    });
  });

  describe('correctOpeningBalance (Finance Correction Pass)', () => {
    beforeEach(() => {
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      finance.applyOpeningBalanceCorrection.mockResolvedValue({ id: 'adj-1' });
    });

    it('computes the delta as targetBalance minus the current effective opening balance (first-ever correction, previous 0)', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(0);

      await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: 500_000, reason: 'Initial ledger correction' },
        'actor-1',
        'req-1',
      );

      // `applyOpeningBalanceCorrection` — not the generic `createAdjustment`
      // — is the dedicated method for this feature (see its own doc
      // comment on `finance.repository.ts`: `createAdjustment`'s
      // ChargeItem-only, no-credit-on-excess waiver semantics are wrong for
      // an opening-balance correction). It hardcodes
      // `sourceType: 'OPENING_BALANCE_CORRECTION'` internally rather than
      // taking it as a caller-supplied param.
      expect(finance.applyOpeningBalanceCorrection).toHaveBeenCalledWith(
        expect.objectContaining({
          unitId: 'u1',
          buildingId: 'b1',
          fundId: 'fund-default',
          amount: 500_000,
          reason: 'Initial ledger correction',
          createdById: 'actor-1',
          requestId: 'req-1',
        }),
      );
    });

    it('computes a smaller positive delta when a prior correction already moved the balance partway', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(200_000);

      await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: 500_000, reason: 'Top-up correction' },
        'actor-1',
        'req-1',
      );

      expect(finance.applyOpeningBalanceCorrection).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 300_000 }),
      );
    });

    it('computes a negative delta (waiver) when the target is below the current effective opening balance', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(500_000);

      await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: 100_000, reason: 'Overstated originally' },
        'actor-1',
        'req-1',
      );

      expect(finance.applyOpeningBalanceCorrection).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -400_000 }),
      );
    });

    it('supports a negative targetBalance (correcting to a credit)', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(0);

      await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: -150_000, reason: 'Actually a credit' },
        'actor-1',
        'req-1',
      );

      expect(finance.applyOpeningBalanceCorrection).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -150_000 }),
      );
    });

    it('rejects a correction whose target matches the current effective opening balance (zero delta), without calling FinanceRepository.applyOpeningBalanceCorrection', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(500_000);

      await expect(
        service.correctOpeningBalance(
          'b1',
          'u1',
          { targetBalance: 500_000, reason: 'No-op' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.applyOpeningBalanceCorrection).not.toHaveBeenCalled();
    });

    it('rejects a deactivated explicit Fund and never reaches FinanceRepository.applyOpeningBalanceCorrection', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(0);
      finance.findFundById.mockResolvedValue(INACTIVE_FUND);

      await expect(
        service.correctOpeningBalance(
          'b1',
          'u1',
          { targetBalance: 100_000, reason: 'x', fundId: 'fund-2' },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.applyOpeningBalanceCorrection).not.toHaveBeenCalled();
    });

    it('records an audit entry with previousBalance/newBalance/delta — the before/after snapshot manual createAdjustment does not capture', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(200_000);

      await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: 500_000, reason: 'Top-up correction' },
        'actor-1',
        'req-1',
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          buildingId: 'b1',
          action: 'UnitOpeningBalanceCorrected',
          entityType: 'Adjustment',
          entityId: 'adj-1',
          reason: 'Top-up correction',
          metadata: {
            unitId: 'u1',
            previousBalance: 200_000,
            newBalance: 500_000,
            delta: 300_000,
          },
        }),
      );
    });

    it('emits AdjustmentCreatedEvent with the computed delta (not the raw targetBalance)', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(200_000);

      await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: 500_000, reason: 'Top-up correction' },
        'actor-1',
        'req-1',
      );

      expect(events.emit).toHaveBeenCalledWith(
        'AdjustmentCreated',
        expect.objectContaining({
          adjustmentId: 'adj-1',
          buildingId: 'b1',
          unitId: 'u1',
          amount: 300_000,
          createdById: 'actor-1',
        }),
      );
    });

    it('returns previousBalance/newBalance/delta alongside the created adjustment', async () => {
      finance.getUnitOpeningBalanceCorrectionTotal.mockResolvedValue(200_000);

      const result = await service.correctOpeningBalance(
        'b1',
        'u1',
        { targetBalance: 500_000, reason: 'Top-up correction' },
        'actor-1',
        'req-1',
      );

      expect(result).toEqual({
        adjustment: { id: 'adj-1' },
        previousBalance: 200_000,
        newBalance: 500_000,
        delta: 300_000,
      });
    });
  });

  describe('previewChargeBatch — Fund resolution (read-only, mirrors resolveFundForWrite)', () => {
    const dto = {
      title: 'Preview',
      calculationMethod: 'FIXED' as const,
      amountPerUnit: 50_000,
    };

    it('rejects an explicit fundId pointing at a deactivated Fund, without creating anything', async () => {
      finance.findFundById.mockResolvedValue(INACTIVE_FUND);

      await expect(
        service.previewChargeBatch('b1', { ...dto, fundId: 'fund-2' }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createChargeBatch).not.toHaveBeenCalled();
    });

    it('surfaces willCreateDefaultFund (never calling getOrCreateDefaultFund) when no default fund exists yet', async () => {
      finance.findDefaultFund.mockResolvedValue(null);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);

      const result = await service.previewChargeBatch('b1', dto);

      expect(result.willCreateDefaultFund).toBe(true);
      expect(result.fund).toBeNull();
      expect(finance.getOrCreateDefaultFund).not.toHaveBeenCalled();
    });

    it('reflects an existing active default fund without creating one', async () => {
      finance.findDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);

      const result = await service.previewChargeBatch('b1', dto);

      expect(result.fund).toEqual({ id: 'fund-default', name: undefined });
      expect(result.willCreateDefaultFund).toBe(false);
    });
  });

  describe('createChargeBatch orchestration', () => {
    it('MIXED delegates the explicit items verbatim, never calling buildings.listUnits', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        {
          title: 'Mixed batch',
          calculationMethod: 'MIXED',
          items: [{ unitId: 'u1', amount: 10_000 }],
        },
        'actor-1',
        'req-1',
      );

      expect(buildings.listUnits).not.toHaveBeenCalled();
      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ unitId: 'u1', amount: 10_000 }],
          unitScope: undefined,
        }),
      );
    });

    it('FIXED resolves unitScope RESIDENTIAL to only RESIDENTIAL units', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'COMMERCIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        {
          title: 'Residential only',
          calculationMethod: 'FIXED',
          amountPerUnit: 100_000,
          unitScope: 'RESIDENTIAL',
        },
        'actor-1',
        'req-1',
      );

      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ unitId: 'u1', amount: 100_000 }],
          unitScope: 'RESIDENTIAL',
        }),
      );
    });

    it('AREA_BASED skips units with no areaSqm configured, rather than charging them 0', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: 50 },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Area based', calculationMethod: 'AREA_BASED', ratePerSqm: 1_000 },
        'actor-1',
        'req-1',
      );

      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({ items: [{ unitId: 'u1', amount: 50_000 }] }),
      );
    });

    it('rejects MANUAL scope with a unitId outside the building via ChargePolicy.assertUnitsBelongToBuilding, never reaching the repository', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);

      await expect(
        service.createChargeBatch(
          'b1',
          {
            title: 'Manual',
            calculationMethod: 'FIXED',
            amountPerUnit: 1_000,
            unitScope: 'MANUAL',
            unitIds: ['other-building-unit'],
          },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createChargeBatch).not.toHaveBeenCalled();
    });

    it('records a ChargeBatchCreated audit entry with itemCount/unitScope/payerType metadata', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Mehr', calculationMethod: 'FIXED', amountPerUnit: 100_000 },
        'actor-1',
        'req-1',
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ChargeBatchCreated',
          entityId: 'batch-1',
          metadata: expect.objectContaining({ itemCount: 1, unitScope: 'ALL' }),
        }),
      );
    });
  });

  describe('issueChargeBatch — payer snapshot timing (ADR-095)', () => {
    it('never calls resolvePayers/BuildingRepository when the batch has no requested payerType', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'DRAFT',
        totalAmount: 100_000,
        fundId: 'fund-1',
        payerType: null,
        chargeItems: [{ id: 'item-1', unitId: 'u1' }],
      });
      finance.issueChargeBatch.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });

      await service.issueChargeBatch('b1', 'batch-1', 'actor-1', 'req-1');

      expect(buildings.findCurrentTenancyForUnit).not.toHaveBeenCalled();
      expect(buildings.getCurrentOwnerPersonIds).not.toHaveBeenCalled();
      expect(finance.issueChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({ payerResolutions: [] }),
      );
    });

    it('resolves TENANT payer snapshots at issue time (not draft time) and passes them into the same atomic issue call', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'DRAFT',
        totalAmount: 100_000,
        fundId: 'fund-1',
        payerType: 'TENANT',
        chargeItems: [{ id: 'item-1', unitId: 'u1' }],
      });
      buildings.findCurrentTenancyForUnit.mockResolvedValue({ personId: 'tenant-1' });
      finance.issueChargeBatch.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });

      await service.issueChargeBatch('b1', 'batch-1', 'actor-1', 'req-1');

      expect(finance.issueChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payerResolutions: [
            { chargeItemId: 'item-1', resolvedPayerType: 'TENANT', personIds: ['tenant-1'] },
          ],
        }),
      );
    });

    it('falls back a TENANT-requested batch to OWNER (all current co-owners) when the unit has no active tenant', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'DRAFT',
        totalAmount: 100_000,
        fundId: 'fund-1',
        payerType: 'TENANT',
        chargeItems: [{ id: 'item-1', unitId: 'u1' }],
      });
      buildings.findCurrentTenancyForUnit.mockResolvedValue(null);
      buildings.getCurrentOwnerPersonIds.mockResolvedValue(['owner-1', 'owner-2']);
      finance.issueChargeBatch.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });

      await service.issueChargeBatch('b1', 'batch-1', 'actor-1', 'req-1');

      expect(finance.issueChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payerResolutions: [
            {
              chargeItemId: 'item-1',
              resolvedPayerType: 'OWNER',
              personIds: ['owner-1', 'owner-2'],
            },
          ],
        }),
      );
    });

    it('rejects issuing a non-DRAFT batch via ChargePolicy.assertIssuable, never calling the repository', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'ISSUED',
        totalAmount: 100_000,
        chargeItems: [],
      });

      await expect(
        service.issueChargeBatch('b1', 'batch-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.issueChargeBatch).not.toHaveBeenCalled();
    });

    it('emits ChargeBatchIssuedEvent with the correct totalAmount after a successful issue', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'DRAFT',
        totalAmount: 250_000,
        fundId: 'fund-1',
        payerType: null,
        chargeItems: [],
      });
      finance.issueChargeBatch.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });

      await service.issueChargeBatch('b1', 'batch-1', 'actor-1', 'req-1');

      expect(events.emit).toHaveBeenCalledWith(
        'ChargeBatchIssued',
        expect.objectContaining({
          chargeBatchId: 'batch-1',
          buildingId: 'b1',
          totalAmount: 250_000,
          issuedById: 'actor-1',
        }),
      );
    });
  });

  describe('cancelChargeBatch', () => {
    it('rejects cancelling a batch with paid ChargeItems via ChargePolicy.assertCancellable', async () => {
      finance.findChargeBatchById.mockResolvedValue({ id: 'batch-1', buildingId: 'b1', status: 'ISSUED' });
      finance.hasAnyPaidChargeItems.mockResolvedValue(true);

      await expect(
        service.cancelChargeBatch('b1', 'batch-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.cancelChargeBatch).not.toHaveBeenCalled();
    });

    it('cancels and emits ChargeBatchCancelledEvent when no payments have been applied', async () => {
      finance.findChargeBatchById.mockResolvedValue({ id: 'batch-1', buildingId: 'b1', status: 'ISSUED' });
      finance.hasAnyPaidChargeItems.mockResolvedValue(false);
      finance.cancelChargeBatch.mockResolvedValue({ id: 'batch-1', status: 'CANCELLED' });

      await service.cancelChargeBatch('b1', 'batch-1', 'actor-1', 'req-1');

      expect(events.emit).toHaveBeenCalledWith(
        'ChargeBatchCancelled',
        expect.objectContaining({ chargeBatchId: 'batch-1', buildingId: 'b1' }),
      );
    });
  });

  describe('applyLateFee — idempotency', () => {
    const chargeItem = {
      id: 'item-1',
      unitId: 'u1',
      amount: 500_000,
      paidAmount: 0,
      chargeBatch: {
        buildingId: 'b1',
        fundId: 'fund-1',
        title: 'Mehr',
        status: 'ISSUED',
        dueDate: new Date('2026-01-01T00:00:00Z'),
        lateFeeType: 'FIXED',
        lateFeeValue: 20_000,
        lateFeeGraceDays: 0,
      },
    };

    it('404s when the ChargeItem does not belong to the given unit', async () => {
      finance.findChargeItemById.mockResolvedValue({ ...chargeItem, unitId: 'other-unit' });

      await expect(
        service.applyLateFee('b1', 'u1', 'item-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
    });

    it('throws DuplicateError (409) when a late fee was already applied, never calling createAdjustment', async () => {
      finance.findChargeItemById.mockResolvedValue(chargeItem);
      finance.findAdjustmentBySource.mockResolvedValue({ id: 'adj-existing' });

      await expect(
        service.applyLateFee('b1', 'u1', 'item-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(DuplicateError);
      expect(finance.createAdjustment).not.toHaveBeenCalled();
    });

    it('rejects an ineligible item (before dueDate + grace) with BusinessRuleViolationError', async () => {
      finance.findChargeItemById.mockResolvedValue({
        ...chargeItem,
        chargeBatch: { ...chargeItem.chargeBatch, dueDate: new Date('2099-01-01T00:00:00Z') },
      });
      finance.findAdjustmentBySource.mockResolvedValue(null);

      await expect(
        service.applyLateFee('b1', 'u1', 'item-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });

    it('applies an eligible late fee as a positive Adjustment and emits AdjustmentCreatedEvent', async () => {
      finance.findChargeItemById.mockResolvedValue(chargeItem);
      finance.findAdjustmentBySource.mockResolvedValue(null);
      finance.createAdjustment.mockResolvedValue({ id: 'adj-1' });

      await service.applyLateFee('b1', 'u1', 'item-1', 'actor-1', 'req-1');

      expect(finance.createAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ sourceType: 'LATE_FEE', sourceId: 'item-1', amount: 20_000 }),
      );
      expect(events.emit).toHaveBeenCalledWith('AdjustmentCreated', expect.anything());
    });

    it('converts a concurrent P2002 unique-constraint race into a clean DuplicateError, not an unhandled 500', async () => {
      finance.findChargeItemById.mockResolvedValue(chargeItem);
      finance.findAdjustmentBySource.mockResolvedValue(null);
      const { Prisma } = jest.requireActual('@prisma/client');
      const raceError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
      raceError.code = 'P2002';
      finance.createAdjustment.mockRejectedValue(raceError);

      await expect(
        service.applyLateFee('b1', 'u1', 'item-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(DuplicateError);
    });
  });

  describe('approvePayment / rejectPayment', () => {
    it('rejects approving a non-PENDING_APPROVAL payment via PaymentPolicy.assertPending', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        status: 'APPROVED',
      });

      await expect(
        service.approvePayment('b1', 'pay-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.approvePayment).not.toHaveBeenCalled();
    });

    it('approves a pending payment, delegating amount/unitId/fundId verbatim, and emits PaymentApprovedEvent with the payerId (ADR-028)', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 300_000,
        payerId: 'payer-1',
        status: 'PENDING_APPROVAL',
      });
      finance.approvePayment.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });

      await service.approvePayment('b1', 'pay-1', 'manager-1', 'req-1');

      expect(finance.approvePayment).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: 'pay-1', unitId: 'u1', fundId: 'fund-1', amount: 300_000 }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'PaymentApproved',
        expect.objectContaining({ paymentId: 'pay-1', payerId: 'payer-1', amount: 300_000 }),
      );
    });

    it('rejects rejecting an already-rejected payment', async () => {
      finance.findPaymentById.mockResolvedValue({ id: 'pay-1', buildingId: 'b1', status: 'REJECTED' });

      await expect(
        service.rejectPayment('b1', 'pay-1', { reason: 'dup' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('reversePayment / refundPayment — options.auditAction passthrough (ADR-113)', () => {
    it('reversePayment records the default PaymentReversed action when options is omitted', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 100_000,
        status: 'APPROVED',
      });
      finance.reversePayment.mockResolvedValue({ id: 'pay-1', status: 'REVERSED' });

      await service.reversePayment('b1', 'pay-1', { reason: 'bounced' }, 'actor-1', 'req-1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PaymentReversed' }),
      );
    });

    it('reversePayment records the override action name when options.auditAction is supplied, without changing the policy check or repository call', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 100_000,
        status: 'APPROVED',
      });
      finance.reversePayment.mockResolvedValue({ id: 'pay-1', status: 'REVERSED' });

      await service.reversePayment('b1', 'pay-1', { reason: 'staff override' }, 'staff-1', 'req-1', {
        auditAction: 'PaymentReversedByAdmin',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PaymentReversedByAdmin' }),
      );
      expect(finance.reversePayment).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: 'pay-1', amount: 100_000 }),
      );
    });

    it('rejects reversing a non-APPROVED payment via PaymentPolicy.assertReversible', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        status: 'PENDING_APPROVAL',
      });

      await expect(
        service.reversePayment('b1', 'pay-1', { reason: 'x' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.reversePayment).not.toHaveBeenCalled();
    });

    it('refundPayment records the override action name when options.auditAction is supplied', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 100_000,
        status: 'APPROVED',
      });
      finance.findRefundsByPayment.mockResolvedValue([]);
      finance.createRefund.mockResolvedValue({ id: 'refund-1' });

      await service.refundPayment(
        'b1',
        'pay-1',
        { reason: 'goodwill' },
        'staff-1',
        'req-1',
        { auditAction: 'PaymentRefundedByAdmin' },
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PaymentRefundedByAdmin' }),
      );
    });

    it('refundPayment rejects a second refund on an already-refunded payment (PaymentPolicy.assertRefundable)', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        amount: 100_000,
        status: 'APPROVED',
      });
      finance.findRefundsByPayment.mockResolvedValue([{ id: 'refund-existing' }]);

      await expect(
        service.refundPayment('b1', 'pay-1', { reason: 'again' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createRefund).not.toHaveBeenCalled();
    });

    it('refundPayment defaults the refund amount to the full original payment amount when dto.amount is omitted', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 400_000,
        status: 'APPROVED',
      });
      finance.findRefundsByPayment.mockResolvedValue([]);
      finance.createRefund.mockResolvedValue({ id: 'refund-1' });

      await service.refundPayment('b1', 'pay-1', { reason: 'full refund' }, 'actor-1', 'req-1');

      expect(finance.createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 400_000, paymentAmount: 400_000 }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'PaymentRefunded',
        expect.objectContaining({ isFullRefund: true }),
      );
    });
  });

  describe('getUnitDebt — eligible late fee aggregation', () => {
    it('sums only eligible candidates into eligibleLateFeeTotal, excluding ineligible ones', async () => {
      finance.getUnitDebt.mockResolvedValue({
        chargeItemDebt: 500_000,
        adjustmentDebt: 0,
        totalDebt: 500_000,
        creditBalance: 0,
      });
      finance.listLateFeeEligibleCandidates.mockResolvedValue([
        {
          id: 'item-eligible',
          amount: 500_000,
          paidAmount: 0,
          chargeBatch: {
            status: 'ISSUED',
            dueDate: new Date('2020-01-01T00:00:00Z'),
            lateFeeType: 'FIXED',
            lateFeeValue: 15_000,
            lateFeeGraceDays: 0,
          },
        },
        {
          id: 'item-not-yet-due',
          amount: 500_000,
          paidAmount: 0,
          chargeBatch: {
            status: 'ISSUED',
            dueDate: new Date('2099-01-01T00:00:00Z'),
            lateFeeType: 'FIXED',
            lateFeeValue: 15_000,
            lateFeeGraceDays: 0,
          },
        },
      ]);
      finance.findAppliedLateFeeChargeItemIds.mockResolvedValue(new Set());
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });

      const result = await service.getUnitDebt('b1', 'u1');

      expect(result.eligibleLateFeeTotal).toBe(15_000);
      expect(result.eligibleLateFees).toEqual([{ chargeItemId: 'item-eligible', amount: 15_000 }]);
      expect(result.totalDebt).toBe(500_000);
    });
  });

  describe('pagination pass-through (Finance Hardening Pass)', () => {
    it('listFunds converts page/limit into skip/take and returns { items, meta } built from the repository total', async () => {
      finance.listFunds.mockResolvedValue({ items: [{ id: 'f1' }, { id: 'f2' }], total: 45 });

      const result = await service.listFunds('b1', { page: 2, limit: 20 });

      expect(finance.listFunds).toHaveBeenCalledWith('b1', { skip: 20, take: 20 });
      expect(result.meta).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
      expect(result.items).toHaveLength(2);
    });

    it('listFunds default page 1 computes skip 0', async () => {
      finance.listFunds.mockResolvedValue({ items: [], total: 0 });

      const result = await service.listFunds('b1', { page: 1, limit: 20 });

      expect(finance.listFunds).toHaveBeenCalledWith('b1', { skip: 0, take: 20 });
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
      expect(result.items).toEqual([]);
    });

    it('listLedger threads the fundId filter through alongside pagination', async () => {
      finance.listLedger.mockResolvedValue({ items: [], total: 0 });

      await service.listLedger('b1', 'fund-1', { page: 1, limit: 20 });

      expect(finance.listLedger).toHaveBeenCalledWith('b1', 'fund-1', { skip: 0, take: 20 });
    });

    it('listPayments threads an optional status filter through alongside pagination (Backend ↔ Mobile Contract Alignment)', async () => {
      finance.listPayments.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });

      const result = await service.listPayments('b1', { page: 1, limit: 20 }, 'PENDING_APPROVAL');

      expect(finance.listPayments).toHaveBeenCalledWith(
        'b1',
        { skip: 0, take: 20 },
        'PENDING_APPROVAL',
      );
      expect(result.items).toEqual([{ id: 'p1' }]);
    });

    it('listPayments passes status through as undefined when omitted, unchanged from pre-existing behavior', async () => {
      finance.listPayments.mockResolvedValue({ items: [], total: 0 });

      await service.listPayments('b1', { page: 1, limit: 20 });

      expect(finance.listPayments).toHaveBeenCalledWith('b1', { skip: 0, take: 20 }, undefined);
    });

    it('listUnitChargeItems computes lateFee only over the returned page, and still reports the true total in meta', async () => {
      finance.listChargeItemsByUnit.mockResolvedValue({
        items: [
          {
            id: 'item-1',
            amount: 100_000,
            paidAmount: 0,
            chargeBatch: {
              status: 'DRAFT',
              lateFeeType: null,
              lateFeeValue: null,
              lateFeeGraceDays: null,
              dueDate: null,
            },
          },
        ],
        total: 57,
      });
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });

      const result = await service.listUnitChargeItems('b1', 'u1', { page: 1, limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lateFee).toBeNull();
      expect(result.meta.total).toBe(57);
    });
  });
});
