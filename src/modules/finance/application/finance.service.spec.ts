import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { FinanceService } from './finance.service';
import { FinanceRepository } from '../infrastructure/repositories/finance.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { ChargePolicy } from '../domain/policies/charge.policy';
import { PaymentPolicy } from '../domain/policies/payment.policy';
import { FundPolicy } from '../domain/policies/fund.policy';
import { ExpensePolicy } from '../domain/policies/expense.policy';
import { ChargeFundAlignmentPolicy } from '../domain/policies/charge-fund-alignment.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ChargeFundSelectionRequiredError,
  ConflictError,
  DeprecatedChargeKindError,
  DuplicateError,
  IncompatibleChargeFundError,
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

  const ACTIVE_FUND = {
    id: 'fund-1',
    name: 'Current',
    type: 'CURRENT' as const,
    buildingId: 'b1',
    isActive: true,
    isDefault: false,
  };
  const INACTIVE_FUND = { ...ACTIVE_FUND, id: 'fund-2', isActive: false };
  const DEFAULT_FUND = { ...ACTIVE_FUND, id: 'fund-default', isDefault: true };

  beforeEach(() => {
    finance = {
      findFundById: jest.fn(),
      listActiveChargeOptionFunds: jest.fn(),
      getOrCreateDefaultFund: jest.fn(),
      findDefaultFund: jest.fn(),
      createFund: jest.fn(),
      listFunds: jest.fn(),
      updateFund: jest.fn(),
      setFundActive: jest.fn(),
      createChargeBatch: jest.fn(),
      listChargeSeries: jest.fn(),
      createChargeSeries: jest.fn(),
      findChargeSeriesById: jest.fn(),
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
      listUnitDebtSummaries: jest.fn(),
      getUnitOpeningBalanceCorrectionTotal: jest.fn(),
      applyOpeningBalanceCorrection: jest.fn(),
      createPayment: jest.fn(),
      listPayments: jest.fn(),
      listPaymentsByUnit: jest.fn(),
      listPaymentReceiptsByPaymentIds: jest.fn().mockResolvedValue([]),
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
      createExpense: jest.fn(),
      findExpenseById: jest.fn(),
      findExpenseByIdempotencyKey: jest.fn(),
      voidExpense: jest.fn(),
      listExpenses: jest.fn(),
    };
    buildings = {
      findById: jest.fn().mockResolvedValue({ id: 'b1' }),
      listUnits: jest.fn().mockResolvedValue([]),
      findUnitById: jest.fn(),
      findCurrentTenancyForUnit: jest.fn().mockResolvedValue(null),
      getCurrentOwnerPersonIds: jest.fn().mockResolvedValue([]),
      getRoles: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };

    service = new FinanceService(
      finance as unknown as FinanceRepository,
      buildings as unknown as BuildingRepository,
      new ChargePolicy(),
      new PaymentPolicy(),
      new FundPolicy(),
      new ExpensePolicy(),
      new ChargeFundAlignmentPolicy(),
      audit as unknown as AuditService,
      events as unknown as EventEmitter2,
    );
  });

  describe('charge classification and series', () => {
    const baseDto = {
      title: 'Monthly charge',
      calculationMethod: 'FIXED' as const,
      totalAmount: 100_000,
    };

    it('lists active series through the building-scoped repository query', async () => {
      finance.listChargeSeries.mockResolvedValue([{ id: 's1', name: 'Monthly' }]);
      await expect(service.listChargeSeries('b1')).resolves.toEqual([
        { id: 's1', name: 'Monthly' },
      ]);
      expect(finance.listChargeSeries).toHaveBeenCalledWith('b1');
    });

    it('creates a trimmed series and maps duplicate names to DuplicateError', async () => {
      finance.createChargeSeries.mockResolvedValueOnce({ id: 's1', name: 'Monthly' });
      await service.createChargeSeries('b1', { name: '  Monthly  ' });
      expect(finance.createChargeSeries).toHaveBeenCalledWith('b1', 'Monthly');

      const race = Object.assign(new Error('unique'), { code: 'P2002', clientVersion: '5.22.0' });
      Object.setPrototypeOf(race, Prisma.PrismaClientKnownRequestError.prototype);
      finance.createChargeSeries.mockRejectedValueOnce(race);
      await expect(service.createChargeSeries('b1', { name: 'Monthly' })).rejects.toBeInstanceOf(
        DuplicateError,
      );
    });

    it('persists MONTHLY metadata and returns the same classification from preview', async () => {
      const series = { id: 's1', buildingId: 'b1', name: 'Monthly', isActive: true };
      const dto = {
        ...baseDto,
        chargeKind: 'MONTHLY' as const,
        seriesId: 's1',
        periodStart: '2026-08-23T00:00:00.000Z',
      };
      finance.findChargeSeriesById.mockResolvedValue(series);
      finance.listActiveChargeOptionFunds.mockResolvedValue([DEFAULT_FUND]);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch('b1', dto, 'actor-1', 'req-1');
      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'MONTHLY',
          seriesId: 's1',
          periodStart: new Date(dto.periodStart),
        }),
      );

      const preview = await service.previewChargeBatch('b1', dto);
      expect(preview).toEqual(
        expect.objectContaining({
          chargeKind: 'MONTHLY',
          series: { id: 's1', name: 'Monthly' },
          periodStart: dto.periodStart,
          grandTotal: 100_000,
        }),
      );
    });

    it('rejects a series from another building in both preview and create', async () => {
      finance.findChargeSeriesById.mockResolvedValue({
        id: 's2',
        buildingId: 'b2',
        name: 'Other',
        isActive: true,
      });
      const dto = {
        ...baseDto,
        chargeKind: 'MONTHLY' as const,
        seriesId: 's2',
        periodStart: '2026-09-01T00:00:00.000Z',
      };
      await expect(service.previewChargeBatch('b1', dto)).rejects.toBeInstanceOf(NotFoundAppError);
      await expect(service.createChargeBatch('b1', dto, 'a1', 'r1')).rejects.toBeInstanceOf(
        NotFoundAppError,
      );
      expect(finance.createChargeBatch).not.toHaveBeenCalled();
    });

    it('returns only supported kinds backed by active funds, in frozen order', async () => {
      finance.listActiveChargeOptionFunds.mockResolvedValue([
        { id: 'custom-2', name: 'Z custom', type: 'CUSTOM' },
        { id: 'current-1', name: 'Current', type: 'CURRENT' },
        { id: 'custom-1', name: 'A custom', type: 'CUSTOM' },
      ]);

      await expect(service.getChargeOptions('b1')).resolves.toEqual({
        chargeKinds: [
          {
            kind: 'MONTHLY',
            funds: [{ id: 'current-1', name: 'Current', type: 'CURRENT' }],
          },
          {
            kind: 'OTHER',
            funds: [
              { id: 'custom-2', name: 'Z custom', type: 'CUSTOM' },
              { id: 'custom-1', name: 'A custom', type: 'CUSTOM' },
            ],
          },
        ],
      });
    });

    it('auto-resolves one compatible fund but requires fundId for zero or multiple matches', async () => {
      const dto = { ...baseDto, chargeKind: 'REPAIR' as const };
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });
      finance.listActiveChargeOptionFunds.mockResolvedValue([
        { ...ACTIVE_FUND, id: 'renovation-1', type: 'RENOVATION' },
      ]);
      await service.createChargeBatch('b1', dto, 'a1', 'r1');
      expect(finance.createChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({ fundId: 'renovation-1', expectedFundType: 'RENOVATION' }),
      );

      finance.listActiveChargeOptionFunds.mockResolvedValue([]);
      await expect(service.previewChargeBatch('b1', dto)).rejects.toBeInstanceOf(
        ChargeFundSelectionRequiredError,
      );
      finance.listActiveChargeOptionFunds.mockResolvedValue([
        { ...ACTIVE_FUND, id: 'r1', type: 'RENOVATION' },
        { ...ACTIVE_FUND, id: 'r2', type: 'RENOVATION' },
      ]);
      await expect(service.previewChargeBatch('b1', dto)).rejects.toBeInstanceOf(
        ChargeFundSelectionRequiredError,
      );
    });

    it('rejects mismatches and SPECIAL in both preview and create', async () => {
      finance.findFundById.mockResolvedValue(ACTIVE_FUND);
      const mismatch = { ...baseDto, chargeKind: 'REPAIR' as const, fundId: 'fund-1' };
      await expect(service.previewChargeBatch('b1', mismatch)).rejects.toBeInstanceOf(
        IncompatibleChargeFundError,
      );
      await expect(service.createChargeBatch('b1', mismatch, 'a1', 'r1')).rejects.toBeInstanceOf(
        IncompatibleChargeFundError,
      );

      const special = { ...baseDto, chargeKind: 'SPECIAL' as const, fundId: 'fund-1' };
      await expect(service.previewChargeBatch('b1', special)).rejects.toBeInstanceOf(
        DeprecatedChargeKindError,
      );
      await expect(service.createChargeBatch('b1', special, 'a1', 'r1')).rejects.toBeInstanceOf(
        DeprecatedChargeKindError,
      );
    });
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
        new BusinessRuleViolationError(
          "This amount exceeds the unit's remaining payable amount (0).",
        ),
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

      expect(result.fund).toEqual({ id: 'fund-default', name: 'Current' });
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

  describe('FIN-CALC-01 — totalAmount allocation (equal / area-based)', () => {
    it('100/3 equal allocation across 3 units sums exactly to 100, base+remainder deterministic on unit order', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u3', type: 'RESIDENTIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Equal split', calculationMethod: 'FIXED', totalAmount: 100 },
        'actor-1',
        'req-1',
      );

      const items = finance.createChargeBatch.mock.calls[0][0].items;
      expect(items).toEqual([
        { unitId: 'u1', amount: 34 },
        { unitId: 'u2', amount: 33 },
        { unitId: 'u3', amount: 33 },
      ]);
      expect(items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)).toBe(100);
    });

    it('a totalAmount smaller than the number of units still sums exactly, with amount-0 items for the units that miss out', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u3', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u4', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u5', type: 'RESIDENTIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Tiny total', calculationMethod: 'FIXED', totalAmount: 2 },
        'actor-1',
        'req-1',
      );

      const items = finance.createChargeBatch.mock.calls[0][0].items;
      expect(items).toEqual([
        { unitId: 'u1', amount: 1 },
        { unitId: 'u2', amount: 1 },
        { unitId: 'u3', amount: 0 },
        { unitId: 'u4', amount: 0 },
        { unitId: 'u5', amount: 0 },
      ]);
      expect(items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)).toBe(2);
    });

    it('a single eligible unit gets the entire totalAmount', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'One unit', calculationMethod: 'FIXED', totalAmount: 777 },
        'actor-1',
        'req-1',
      );

      expect(finance.createChargeBatch.mock.calls[0][0].items).toEqual([
        { unitId: 'u1', amount: 777 },
      ]);
    });

    it('RESIDENTIAL unitScope is the denominator for equal allocation — the COMMERCIAL unit gets nothing and is excluded from the split', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u3', type: 'COMMERCIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        {
          title: 'Residential only',
          calculationMethod: 'FIXED',
          totalAmount: 100,
          unitScope: 'RESIDENTIAL',
        },
        'actor-1',
        'req-1',
      );

      const items = finance.createChargeBatch.mock.calls[0][0].items;
      expect(items.map((i: { unitId: string }) => i.unitId)).toEqual(['u1', 'u2']);
      expect(items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)).toBe(100);
    });

    it('MANUAL unitScope is the denominator for equal allocation — only the selected units split the total', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u3', type: 'RESIDENTIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        {
          title: 'Manual split',
          calculationMethod: 'FIXED',
          totalAmount: 100,
          unitScope: 'MANUAL',
          unitIds: ['u1', 'u3'],
        },
        'actor-1',
        'req-1',
      );

      const items = finance.createChargeBatch.mock.calls[0][0].items;
      expect(items.map((i: { unitId: string }) => i.unitId)).toEqual(['u1', 'u3']);
      expect(items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)).toBe(100);
    });

    it('area-based totalAmount splits proportional to unequal areas (50/75/125 sqm) and sums exactly', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: 50 },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: 75 },
        { id: 'u3', type: 'RESIDENTIAL', areaSqm: 125 },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Area split', calculationMethod: 'AREA_BASED', totalAmount: 1_000_000 },
        'actor-1',
        'req-1',
      );

      const items = finance.createChargeBatch.mock.calls[0][0].items;
      // Exact shares: 200_000 / 300_000 / 500_000 (50/75/125 out of 250
      // total sqm) — no fractional remainder to distribute in this case,
      // but the SUM invariant is still asserted explicitly below.
      expect(items).toEqual([
        { unitId: 'u1', amount: 200_000 },
        { unitId: 'u2', amount: 300_000 },
        { unitId: 'u3', amount: 500_000 },
      ]);
      expect(items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)).toBe(
        1_000_000,
      );
    });

    it('area-based totalAmount with a remainder distributes it deterministically by largest fractional share', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: 10 },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: 10 },
        { id: 'u3', type: 'RESIDENTIAL', areaSqm: 10 },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Equal-area remainder', calculationMethod: 'AREA_BASED', totalAmount: 100 },
        'actor-1',
        'req-1',
      );

      const items = finance.createChargeBatch.mock.calls[0][0].items;
      // Equal areas -> equal exact shares (33.33 each) -> equal
      // fractional remainders -> tie-break falls back to stable original
      // order, same as the pure equal-allocation case.
      expect(items).toEqual([
        { unitId: 'u1', amount: 34 },
        { unitId: 'u2', amount: 33 },
        { unitId: 'u3', amount: 33 },
      ]);
      expect(items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)).toBe(100);
    });

    it('area-based totalAmount skips units with no positive area, splitting the total only across the units that have one', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: 100 },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u3', type: 'RESIDENTIAL', areaSqm: 0 },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Partial area', calculationMethod: 'AREA_BASED', totalAmount: 500_000 },
        'actor-1',
        'req-1',
      );

      expect(finance.createChargeBatch.mock.calls[0][0].items).toEqual([
        { unitId: 'u1', amount: 500_000 },
      ]);
    });

    it('rejects an area-based totalAmount batch when zero in-scope units have a positive area (BUSINESS_RULE_VIOLATION, never reaches the repository)', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: 0 },
      ]);

      await expect(
        service.createChargeBatch(
          'b1',
          { title: 'No area anywhere', calculationMethod: 'AREA_BASED', totalAmount: 500_000 },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createChargeBatch).not.toHaveBeenCalled();
    });

    it('rejects sending both totalAmount and the legacy amountPerUnit together (BUSINESS_RULE_VIOLATION, never reaches the repository)', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);

      await expect(
        service.createChargeBatch(
          'b1',
          {
            title: 'Ambiguous',
            calculationMethod: 'FIXED',
            totalAmount: 100_000,
            amountPerUnit: 50_000,
          },
          'actor-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createChargeBatch).not.toHaveBeenCalled();
    });

    it('the legacy amountPerUnit shape is completely unaffected — still charges every eligible unit that exact amount, not a proportional split', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: null },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null },
      ]);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      await service.createChargeBatch(
        'b1',
        { title: 'Legacy unchanged', calculationMethod: 'FIXED', amountPerUnit: 250_000 },
        'actor-1',
        'req-1',
      );

      expect(finance.createChargeBatch.mock.calls[0][0].items).toEqual([
        { unitId: 'u1', amount: 250_000 },
        { unitId: 'u2', amount: 250_000 },
      ]);
    });

    it('previewChargeBatch surfaces a validationWarning when AREA_BASED units are skipped for missing area, and grandTotal still equals the requested totalAmount', async () => {
      buildings.listUnits.mockResolvedValue([
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: 100, unitNumber: '1' },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: null, unitNumber: '2' },
      ]);
      finance.findDefaultFund.mockResolvedValue(DEFAULT_FUND);

      const result = await service.previewChargeBatch('b1', {
        title: 'Preview with gaps',
        calculationMethod: 'AREA_BASED',
        totalAmount: 500_000,
      });

      expect(result.items).toEqual([expect.objectContaining({ unitId: 'u1', amount: 500_000 })]);
      expect(result.grandTotal).toBe(500_000);
      expect(result.validationWarnings).toEqual(
        expect.arrayContaining([
          '1 unit(s) in scope were skipped because they have no positive area configured.',
        ]),
      );
    });

    it('previewChargeBatch and createChargeBatch compute byte-identical items for the same totalAmount request (same resolveChargeItems path)', async () => {
      const units = [
        { id: 'u1', type: 'RESIDENTIAL', areaSqm: 30, unitNumber: '1' },
        { id: 'u2', type: 'RESIDENTIAL', areaSqm: 70, unitNumber: '2' },
      ];
      buildings.listUnits.mockResolvedValue(units);
      finance.findDefaultFund.mockResolvedValue(DEFAULT_FUND);
      finance.getOrCreateDefaultFund.mockResolvedValue(DEFAULT_FUND);
      finance.createChargeBatch.mockResolvedValue({ id: 'batch-1' });

      const dto = {
        title: 'Same math',
        calculationMethod: 'AREA_BASED' as const,
        totalAmount: 333_333,
      };

      const preview = await service.previewChargeBatch('b1', dto);
      await service.createChargeBatch('b1', dto, 'actor-1', 'req-1');

      const createdItems = finance.createChargeBatch.mock.calls[0][0].items;
      expect(preview.items.map((i) => ({ unitId: i.unitId, amount: i.amount }))).toEqual(
        createdItems,
      );
      expect(preview.grandTotal).toBe(333_333);
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

    it('resolves a legacy TENANT-requested payer snapshot to RESIDENT at issue time (not draft time), and passes it into the same atomic issue call (FIN-CTX-01: TENANT is a deprecated input alias — the persisted outcome is always RESIDENT, never TENANT)', async () => {
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
            { chargeItemId: 'item-1', resolvedPayerType: 'RESIDENT', personIds: ['tenant-1'] },
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

  describe('FIN-CTX-01 — RESIDENT payer type (OWNER/RESIDENT domain correction)', () => {
    it('resolves RESIDENT payer snapshots to the current tenant when the unit has an active tenancy (tenant-occupied unit)', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'DRAFT',
        totalAmount: 100_000,
        fundId: 'fund-1',
        payerType: 'RESIDENT',
        chargeItems: [{ id: 'item-1', unitId: 'u1' }],
      });
      buildings.findCurrentTenancyForUnit.mockResolvedValue({ personId: 'tenant-1' });
      finance.issueChargeBatch.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });

      await service.issueChargeBatch('b1', 'batch-1', 'actor-1', 'req-1');

      expect(finance.issueChargeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          payerResolutions: [
            { chargeItemId: 'item-1', resolvedPayerType: 'RESIDENT', personIds: ['tenant-1'] },
          ],
        }),
      );
    });

    it('falls back a RESIDENT-requested batch to OWNER (all current co-owners) when the unit has no active tenant — owner-occupied and genuinely-vacant units are indistinguishable today and both correctly bill the owner', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'DRAFT',
        totalAmount: 100_000,
        fundId: 'fund-1',
        payerType: 'RESIDENT',
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

    it('legacy TENANT input (deprecated alias, kept for the existing Mobile client) resolves identically to RESIDENT and never persists a new TENANT snapshot', async () => {
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

      const call = finance.issueChargeBatch.mock.calls[0][0];
      expect(call.payerResolutions).toEqual([
        { chargeItemId: 'item-1', resolvedPayerType: 'RESIDENT', personIds: ['tenant-1'] },
      ]);
      expect(
        call.payerResolutions.some(
          (r: { resolvedPayerType: string }) => r.resolvedPayerType === 'TENANT',
        ),
      ).toBe(false);
    });

    it('previewChargeBatch resolves RESIDENT identically to issueChargeBatch (tenant-occupied unit) — proves preview/issue semantics never structurally drift', async () => {
      finance.findDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      buildings.findCurrentTenancyForUnit.mockResolvedValue({ personId: 'tenant-1' });

      const result = await service.previewChargeBatch('b1', {
        title: 'Preview',
        calculationMethod: 'FIXED',
        amountPerUnit: 50_000,
        payerType: 'RESIDENT',
      });

      expect(result.items[0]).toEqual(
        expect.objectContaining({ resolvedPayerType: 'RESIDENT', payerPersonIds: ['tenant-1'] }),
      );
    });

    it("previewChargeBatch falls a vacant/owner-occupied unit's RESIDENT request back to OWNER, same as issue", async () => {
      finance.findDefaultFund.mockResolvedValue(DEFAULT_FUND);
      buildings.listUnits.mockResolvedValue([{ id: 'u1', type: 'RESIDENTIAL', areaSqm: null }]);
      buildings.findCurrentTenancyForUnit.mockResolvedValue(null);
      buildings.getCurrentOwnerPersonIds.mockResolvedValue(['owner-1']);

      const result = await service.previewChargeBatch('b1', {
        title: 'Preview',
        calculationMethod: 'FIXED',
        amountPerUnit: 50_000,
        payerType: 'RESIDENT',
      });

      expect(result.items[0]).toEqual(
        expect.objectContaining({ resolvedPayerType: 'OWNER', payerPersonIds: ['owner-1'] }),
      );
    });
  });

  describe('cancelChargeBatch', () => {
    it('rejects cancelling a batch with paid ChargeItems via ChargePolicy.assertCancellable', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'ISSUED',
      });
      finance.hasAnyPaidChargeItems.mockResolvedValue(true);

      await expect(
        service.cancelChargeBatch('b1', 'batch-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.cancelChargeBatch).not.toHaveBeenCalled();
    });

    it('cancels and emits ChargeBatchCancelledEvent when no payments have been applied', async () => {
      finance.findChargeBatchById.mockResolvedValue({
        id: 'batch-1',
        buildingId: 'b1',
        status: 'ISSUED',
      });
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
        expect.objectContaining({
          paymentId: 'pay-1',
          unitId: 'u1',
          fundId: 'fund-1',
          amount: 300_000,
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'PaymentApproved',
        expect.objectContaining({ paymentId: 'pay-1', payerId: 'payer-1', amount: 300_000 }),
      );
    });

    it('rejects rejecting an already-rejected payment', async () => {
      finance.findPaymentById.mockResolvedValue({
        id: 'pay-1',
        buildingId: 'b1',
        status: 'REJECTED',
      });

      await expect(
        service.rejectPayment('b1', 'pay-1', { reason: 'dup' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('getPaymentForViewer — FIN-REC-01B payer-or-finance-reviewer authorization', () => {
    const PAYMENT = {
      id: 'pay-1',
      buildingId: 'b1',
      payerId: 'payer-1',
      method: 'BANK_TRANSFER' as const,
      status: 'PENDING_APPROVAL' as const,
    };

    beforeEach(() => {
      finance.findPaymentById.mockResolvedValue(PAYMENT);
    });

    it('[1.1/7.1] allows the payer of the payment regardless of their building role', async () => {
      buildings.getRoles.mockResolvedValue([]);

      const result = await service.getPaymentForViewer('b1', 'pay-1', 'payer-1');

      expect(result).toEqual(PAYMENT);
      expect(buildings.getRoles).not.toHaveBeenCalled();
    });

    it('[1.2/7.2] allows a MANAGER of the same building who is not the payer', async () => {
      buildings.getRoles.mockResolvedValue(['MANAGER']);

      await expect(service.getPaymentForViewer('b1', 'pay-1', 'manager-1')).resolves.toEqual(
        PAYMENT,
      );
      expect(buildings.getRoles).toHaveBeenCalledWith('manager-1', 'b1');
    });

    it('[1.3/7.3] allows an ACCOUNTANT of the same building who is not the payer', async () => {
      buildings.getRoles.mockResolvedValue(['ACCOUNTANT']);

      await expect(service.getPaymentForViewer('b1', 'pay-1', 'accountant-1')).resolves.toEqual(
        PAYMENT,
      );
    });

    it('[1.4/7.4] rejects a MANAGER/ACCOUNTANT whose role is on a DIFFERENT building — roles are re-derived from payment.buildingId, never trusted from the caller', async () => {
      // This actor may well be MANAGER of some other building — but
      // `buildings.getRoles` is called with `payment.buildingId`, and for
      // THIS building the actor holds no role at all.
      buildings.getRoles.mockResolvedValue([]);

      await expect(
        service.getPaymentForViewer('b1', 'pay-1', 'manager-of-other-building'),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(buildings.getRoles).toHaveBeenCalledWith('manager-of-other-building', 'b1');
    });

    it('[1.5/7.5] rejects a BOARD_MEMBER of the same building who is not the payer and not a finance reviewer', async () => {
      buildings.getRoles.mockResolvedValue(['BOARD_MEMBER']);

      await expect(
        service.getPaymentForViewer('b1', 'pay-1', 'board-member-1'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('[1.6/7.6] rejects an OWNER/TENANT of the unit who is not the payer', async () => {
      buildings.getRoles.mockResolvedValue(['OWNER']);

      await expect(
        service.getPaymentForViewer('b1', 'pay-1', 'owner-not-payer'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('[1.7/7.7] rejects an actor with no membership on this building at all', async () => {
      buildings.getRoles.mockResolvedValue([]);

      await expect(service.getPaymentForViewer('b1', 'pay-1', 'stranger-1')).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it('propagates the stable NotFoundAppError for a payment that does not belong to this building (mirrors getOwnPayment)', async () => {
      finance.findPaymentById.mockResolvedValue({ ...PAYMENT, buildingId: 'other-building' });

      await expect(service.getPaymentForViewer('b1', 'pay-1', 'payer-1')).rejects.toBeInstanceOf(
        NotFoundAppError,
      );
    });

    it('propagates the stable NotFoundAppError for a nonexistent payment', async () => {
      finance.findPaymentById.mockResolvedValue(null);

      await expect(service.getPaymentForViewer('b1', 'missing', 'payer-1')).rejects.toBeInstanceOf(
        NotFoundAppError,
      );
    });
  });

  describe('getPaymentForPayer — FIN-REC-01B exact-payer-only authorization (receipt UPLOAD)', () => {
    // Authorization-audit correction: a receipt is the payer's own
    // attestation of what they submitted; a Manager/Accountant may VIEW
    // one (getPaymentForViewer, above) but must never be able to UPLOAD
    // one on the payer's behalf. This matrix proves the narrower rule —
    // contrast every "allows a MANAGER/ACCOUNTANT..." case above with the
    // corresponding "rejects a MANAGER/ACCOUNTANT..." case here.
    const PAYMENT = {
      id: 'pay-1',
      buildingId: 'b1',
      payerId: 'payer-1',
      method: 'BANK_TRANSFER' as const,
      status: 'PENDING_APPROVAL' as const,
    };

    beforeEach(() => {
      finance.findPaymentById.mockResolvedValue(PAYMENT);
    });

    it('allows the exact payer', async () => {
      await expect(service.getPaymentForPayer('b1', 'pay-1', 'payer-1')).resolves.toEqual(PAYMENT);
      // Unlike getPaymentForViewer, this never even needs to look up roles.
      expect(buildings.getRoles).not.toHaveBeenCalled();
    });

    it('rejects a MANAGER of the same building who is not the payer — receipts may only be uploaded by the exact payer', async () => {
      await expect(service.getPaymentForPayer('b1', 'pay-1', 'manager-1')).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it('rejects an ACCOUNTANT of the same building who is not the payer — receipts may only be uploaded by the exact payer', async () => {
      await expect(
        service.getPaymentForPayer('b1', 'pay-1', 'accountant-1'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('rejects a BOARD_MEMBER of the same building who is not the payer', async () => {
      await expect(
        service.getPaymentForPayer('b1', 'pay-1', 'board-member-1'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('rejects an OWNER/TENANT of the unit who is not the payer', async () => {
      await expect(
        service.getPaymentForPayer('b1', 'pay-1', 'owner-not-payer'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it('rejects an actor with no relationship to this building at all', async () => {
      await expect(service.getPaymentForPayer('b1', 'pay-1', 'stranger-1')).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it('propagates the stable NotFoundAppError for a payment that does not belong to this building (mirrors getOwnPayment)', async () => {
      finance.findPaymentById.mockResolvedValue({ ...PAYMENT, buildingId: 'other-building' });

      await expect(service.getPaymentForPayer('b1', 'pay-1', 'payer-1')).rejects.toBeInstanceOf(
        NotFoundAppError,
      );
    });

    it('propagates the stable NotFoundAppError for a nonexistent payment', async () => {
      finance.findPaymentById.mockResolvedValue(null);

      await expect(service.getPaymentForPayer('b1', 'missing', 'payer-1')).rejects.toBeInstanceOf(
        NotFoundAppError,
      );
    });
  });

  describe('attachReceiptMetadata — FIN-REC-01B list-response enrichment (via listPayments/listUnitPayments)', () => {
    beforeEach(() => {
      buildings.findUnitById.mockResolvedValue({ id: 'u1', buildingId: 'b1' });
    });

    it('[6.1] hasReceipt is false and receipt is null before any receipt exists', async () => {
      finance.listPayments.mockResolvedValue({ items: [{ id: 'p1' }, { id: 'p2' }], total: 2 });
      finance.listPaymentReceiptsByPaymentIds.mockResolvedValue([]);

      const result = await service.listPayments('b1', { page: 1, limit: 20 });

      expect(result.items).toEqual([
        { id: 'p1', hasReceipt: false, receipt: null },
        { id: 'p2', hasReceipt: false, receipt: null },
      ]);
    });

    it('[6.2] hasReceipt is true with the compact {id, filename, contentType, size, createdAt} shape once a receipt exists', async () => {
      const uploadedAt = new Date('2026-08-20T00:00:00.000Z');
      finance.listPayments.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });
      finance.listPaymentReceiptsByPaymentIds.mockResolvedValue([
        {
          entityId: 'p1',
          documentVersion: {
            documentId: 'doc-1',
            fileName: 'receipt.pdf',
            fileType: 'PDF',
            fileSize: 2048,
            uploadedAt,
          },
        },
      ]);

      const result = await service.listPayments('b1', { page: 1, limit: 20 });

      expect(result.items).toEqual([
        {
          id: 'p1',
          hasReceipt: true,
          receipt: {
            id: 'doc-1',
            filename: 'receipt.pdf',
            contentType: 'PDF',
            size: 2048,
            createdAt: uploadedAt,
          },
        },
      ]);
    });

    it('[6.3] never attaches storageKey/bucket/fileUrl/any presigned or permanent URL to the enriched item', async () => {
      finance.listPayments.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });
      finance.listPaymentReceiptsByPaymentIds.mockResolvedValue([
        {
          entityId: 'p1',
          documentVersion: {
            documentId: 'doc-1',
            fileName: 'receipt.pdf',
            fileType: 'PDF',
            fileSize: 2048,
            fileUrl: 'payments/b1/p1/secret-storage-key.pdf',
            uploadedAt: new Date(),
          },
        },
      ]);

      const result = await service.listPayments('b1', { page: 1, limit: 20 });

      const serialized = JSON.stringify(result.items);
      expect(serialized).not.toContain('secret-storage-key');
      expect(serialized).not.toContain('storageKey');
      expect(serialized).not.toContain('bucket');
      expect(Object.keys(result.items[0].receipt as object)).toEqual([
        'id',
        'filename',
        'contentType',
        'size',
        'createdAt',
      ]);
    });

    it('[6.4] a receipt reference for a payment id not in the current page/building batch does not bleed onto an unrelated item (batched lookup keyed strictly by id)', async () => {
      finance.listPayments.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });
      // Simulate a defensive/adversarial repository response that includes
      // an entry for a payment id that was never requested (e.g. a
      // different building's payment) — the enrichment must key strictly
      // off the ids it was given, never leak an unrelated entry onto p1.
      finance.listPaymentReceiptsByPaymentIds.mockResolvedValue([
        {
          entityId: 'p-from-another-building',
          documentVersion: {
            documentId: 'doc-other',
            fileName: 'other.pdf',
            fileType: 'PDF',
            fileSize: 1,
            uploadedAt: new Date(),
          },
        },
      ]);

      const result = await service.listPayments('b1', { page: 1, limit: 20 });

      expect(result.items).toEqual([{ id: 'p1', hasReceipt: false, receipt: null }]);
      expect(finance.listPaymentReceiptsByPaymentIds).toHaveBeenCalledWith(['p1']);
    });

    it('[6.5] enrichment is one batched lookup call, not one call per payment (N+1 sanity)', async () => {
      finance.listPayments.mockResolvedValue({
        items: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
        total: 3,
      });
      finance.listPaymentReceiptsByPaymentIds.mockResolvedValue([]);

      await service.listPayments('b1', { page: 1, limit: 20 });

      expect(finance.listPaymentReceiptsByPaymentIds).toHaveBeenCalledTimes(1);
      expect(finance.listPaymentReceiptsByPaymentIds).toHaveBeenCalledWith(['p1', 'p2', 'p3']);
    });

    it('an empty page never calls the batched lookup at all', async () => {
      finance.listPayments.mockResolvedValue({ items: [], total: 0 });

      const result = await service.listPayments('b1', { page: 1, limit: 20 });

      expect(finance.listPaymentReceiptsByPaymentIds).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
    });

    it('listUnitPayments gets the same hasReceipt/receipt enrichment as listPayments', async () => {
      finance.listPaymentsByUnit.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });
      finance.listPaymentReceiptsByPaymentIds.mockResolvedValue([]);

      const result = await service.listUnitPayments('b1', 'u1', { page: 1, limit: 20 });

      expect(result.items).toEqual([{ id: 'p1', hasReceipt: false, receipt: null }]);
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

      await service.reversePayment(
        'b1',
        'pay-1',
        { reason: 'staff override' },
        'staff-1',
        'req-1',
        {
          auditAction: 'PaymentReversedByAdmin',
        },
      );

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

      await service.refundPayment('b1', 'pay-1', { reason: 'goodwill' }, 'staff-1', 'req-1', {
        auditAction: 'PaymentRefundedByAdmin',
      });

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
    it('paginates unit debt summaries without changing values', async () => {
      buildings.findById.mockResolvedValue({ id: 'b1' });
      finance.listUnitDebtSummaries.mockResolvedValue({
        items: [{ unitId: 'u1', remainingPayable: 25_003_000 }],
        total: 101,
      });
      const result = await service.listUnitDebtSummaries('b1', {
        page: 2,
        limit: 100,
      });
      expect(finance.listUnitDebtSummaries).toHaveBeenCalledWith('b1', {
        skip: 100,
        take: 100,
      });
      expect(result.meta).toEqual({ page: 2, limit: 100, total: 101, totalPages: 2 });
      expect(result.items).toEqual([{ unitId: 'u1', remainingPayable: 25_003_000 }]);
    });

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
      expect(result.items).toEqual([{ id: 'p1', hasReceipt: false, receipt: null }]);
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

  describe('createExpense — Fund resolution, sufficiency, and idempotency (FIN-EXP-02)', () => {
    const dto = {
      title: 'Elevator repair',
      category: 'MAINTENANCE' as const,
      amount: 200_000,
    };

    it('resolves an explicit dto.fundId, asserts sufficiency against its balance, and delegates to the repository', async () => {
      finance.findFundById.mockResolvedValue({ ...ACTIVE_FUND, balance: 1_000_000 });
      finance.createExpense.mockResolvedValue({ id: 'exp-1', ...dto, status: 'POSTED' });

      const result = await service.createExpense(
        'b1',
        { ...dto, fundId: 'fund-1' },
        'actor-1',
        'req-1',
      );

      expect(finance.findFundById).toHaveBeenCalledWith('fund-1');
      expect(finance.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ buildingId: 'b1', fundId: 'fund-1', amount: 200_000 }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ExpenseCreated', entityType: 'Expense' }),
      );
      expect(events.emit).toHaveBeenCalledWith('ExpenseCreated', expect.anything());
      expect(result).toEqual({ id: 'exp-1', ...dto, status: 'POSTED' });
    });

    it('falls back to getOrCreateDefaultFund when dto.fundId is omitted', async () => {
      finance.getOrCreateDefaultFund.mockResolvedValue({ ...DEFAULT_FUND, balance: 1_000_000 });
      finance.createExpense.mockResolvedValue({ id: 'exp-2' });

      await service.createExpense('b1', dto, 'actor-1', 'req-1');

      expect(finance.getOrCreateDefaultFund).toHaveBeenCalledWith('b1');
      expect(finance.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ fundId: 'fund-default' }),
      );
    });

    it('rejects on an inactive fund via FundPolicy.assertActive, never calling the repository', async () => {
      finance.findFundById.mockResolvedValue({ ...INACTIVE_FUND, balance: 1_000_000 });

      await expect(
        service.createExpense('b1', { ...dto, fundId: 'fund-2' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createExpense).not.toHaveBeenCalled();
    });

    it('rejects a non-positive amount via ExpensePolicy.assertValidAmount before resolving any fund', async () => {
      await expect(
        service.createExpense('b1', { ...dto, amount: 0 }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.findFundById).not.toHaveBeenCalled();
      expect(finance.createExpense).not.toHaveBeenCalled();
    });

    it('rejects an amount exceeding the fund balance via ExpensePolicy.assertSufficientFundBalance, never calling the repository', async () => {
      finance.findFundById.mockResolvedValue({ ...ACTIVE_FUND, balance: 100 });

      await expect(
        service.createExpense('b1', { ...dto, fundId: 'fund-1', amount: 200 }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.createExpense).not.toHaveBeenCalled();
    });

    it('on a concurrent P2002 idempotencyKey race, returns the original Expense instead of raising', async () => {
      finance.findFundById.mockResolvedValue({ ...ACTIVE_FUND, balance: 1_000_000 });
      const { Prisma } = jest.requireActual('@prisma/client');
      const raceError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
      raceError.code = 'P2002';
      finance.createExpense.mockRejectedValue(raceError);
      finance.findExpenseByIdempotencyKey.mockResolvedValue({ id: 'exp-original' });

      const result = await service.createExpense(
        'b1',
        { ...dto, fundId: 'fund-1', idempotencyKey: 'key-1' },
        'actor-1',
        'req-1',
      );

      expect(finance.findExpenseByIdempotencyKey).toHaveBeenCalledWith('key-1');
      expect(result).toEqual({ id: 'exp-original' });
      expect(audit.record).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('re-throws a P2002 error when no idempotencyKey was supplied (a real, unexpected constraint violation)', async () => {
      finance.findFundById.mockResolvedValue({ ...ACTIVE_FUND, balance: 1_000_000 });
      const { Prisma } = jest.requireActual('@prisma/client');
      const raceError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
      raceError.code = 'P2002';
      finance.createExpense.mockRejectedValue(raceError);

      await expect(
        service.createExpense('b1', { ...dto, fundId: 'fund-1' }, 'actor-1', 'req-1'),
      ).rejects.toBe(raceError);
      expect(finance.findExpenseByIdempotencyKey).not.toHaveBeenCalled();
    });
  });

  describe('voidExpense — 404 scoping, VOIDED pre-check, and CAS-conflict propagation (FIN-EXP-02)', () => {
    it('404s when the expense does not belong to the given building', async () => {
      finance.findExpenseById.mockResolvedValue({ id: 'exp-1', buildingId: 'other-building' });

      await expect(
        service.voidExpense('b1', 'exp-1', { voidReason: 'oops' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(finance.voidExpense).not.toHaveBeenCalled();
    });

    it('rejects an already-VOIDED expense via ExpensePolicy.assertVoidable, never calling the repository', async () => {
      finance.findExpenseById.mockResolvedValue({
        id: 'exp-1',
        buildingId: 'b1',
        status: 'VOIDED',
      });

      await expect(
        service.voidExpense('b1', 'exp-1', { voidReason: 'oops' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(finance.voidExpense).not.toHaveBeenCalled();
    });

    it('voids a POSTED expense, records audit, and emits ExpenseVoidedEvent', async () => {
      finance.findExpenseById.mockResolvedValue({
        id: 'exp-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 200_000,
        status: 'POSTED',
      });
      finance.voidExpense.mockResolvedValue({ id: 'exp-1', status: 'VOIDED' });

      const result = await service.voidExpense(
        'b1',
        'exp-1',
        { voidReason: 'entered wrong amount' },
        'actor-1',
        'req-1',
      );

      expect(finance.voidExpense).toHaveBeenCalledWith(
        expect.objectContaining({
          expenseId: 'exp-1',
          fundId: 'fund-1',
          amount: 200_000,
          voidReason: 'entered wrong amount',
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ExpenseVoided', entityType: 'Expense' }),
      );
      expect(events.emit).toHaveBeenCalledWith('ExpenseVoided', expect.anything());
      expect(result).toEqual({ id: 'exp-1', status: 'VOIDED' });
    });

    it('propagates a ConflictError from a lost double-void race without swallowing it', async () => {
      finance.findExpenseById.mockResolvedValue({
        id: 'exp-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 200_000,
        status: 'POSTED',
      });
      finance.voidExpense.mockRejectedValue(new ConflictError('This expense is no longer POSTED.'));

      await expect(
        service.voidExpense('b1', 'exp-1', { voidReason: 'dup' }, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('listExpenses / getExpense (FIN-EXP-02)', () => {
    it('passes filters through to the repository and returns paginated meta', async () => {
      finance.listExpenses.mockResolvedValue({ items: [{ id: 'exp-1' }], total: 1 });

      const result = await service.listExpenses(
        'b1',
        { page: 1, limit: 20 },
        { category: 'UTILITIES' as const },
      );

      expect(finance.listExpenses).toHaveBeenCalledWith(
        'b1',
        { skip: 0, take: 20 },
        { category: 'UTILITIES' },
      );
      expect(result.items).toEqual([{ id: 'exp-1' }]);
      expect(result.meta.total).toBe(1);
    });

    it('404s when the expense does not belong to the given building', async () => {
      finance.findExpenseById.mockResolvedValue({ id: 'exp-1', buildingId: 'other-building' });

      await expect(service.getExpense('b1', 'exp-1')).rejects.toBeInstanceOf(NotFoundAppError);
    });

    it('returns the expense when it belongs to the given building', async () => {
      finance.findExpenseById.mockResolvedValue({ id: 'exp-1', buildingId: 'b1' });

      const result = await service.getExpense('b1', 'exp-1');

      expect(result).toEqual({ id: 'exp-1', buildingId: 'b1' });
    });
  });
});
