import { FinanceRepository } from './finance.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { BusinessRuleViolationError, ConflictError } from '../../../../common/errors/app-error';

/**
 * Finance Hardening Pass (post-audit) — `FinanceRepository` unit tests.
 *
 * The audit's own §5/§9 finding: this repository had zero unit-level
 * coverage before this pass, despite owning the highest-risk logic in the
 * whole Finance module — the oldest-debt-first allocation loops
 * (`approvePayment`, `createAdjustment`'s waiver path), the rollback loop
 * (`reversePayment`), and the credit-auto-apply loop (`issueChargeBatch`).
 * Only the e2e suite ever exercised these before now, always through a
 * real Postgres transaction.
 *
 * `PrismaService` is mocked at the `$transaction`/model-method level —
 * `$transaction` is stubbed to invoke the callback with the same mock
 * object every model method lives on, so a test can assert the exact
 * sequence and arguments of every `tx.<model>.<method>` call the
 * transaction body makes, matching the sequential `for...of` + `await`
 * shape the real methods use (the audit's own §6 finding — deliberately
 * left unbatched this pass; see the hardening-pass report for why).
 */
describe('FinanceRepository', () => {
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    unit: { findMany: jest.Mock; count: jest.Mock };
    fund: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    chargeItem: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      createMany: jest.Mock;
    };
    adjustment: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      aggregate: jest.Mock;
    };
    creditBalance: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
    paymentAllocation: { create: jest.Mock; findMany: jest.Mock; aggregate: jest.Mock };
    payment: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
    };
    paymentDebtSelection: { updateMany: jest.Mock };
    refund: { aggregate: jest.Mock; create: jest.Mock; findMany: jest.Mock };
    chargeBatch: {
      count: jest.Mock;
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
    };
    ledgerEntry: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    expense: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
    };
  };
  let repo: FinanceRepository;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
      // Tagged-template mock — `pg_advisory_xact_lock` calls in the SUT use
      // `tx.$executeRaw\`...\`` (tagged template form, not a function call
      // with a query object), so this must accept that call shape.
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'fund-1' }]),
      unit: { findMany: jest.fn(), count: jest.fn() },
      fund: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      chargeItem: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        createMany: jest.fn(),
      },
      adjustment: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        aggregate: jest.fn(),
      },
      creditBalance: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
      },
      paymentAllocation: { create: jest.fn(), findMany: jest.fn(), aggregate: jest.fn() },
      payment: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: 'pay-1',
          status: 'PENDING_APPROVAL',
          selectionMode: 'LEGACY_AUTOMATIC',
          debtSelections: [],
        }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn(),
        aggregate: jest.fn(),
      },
      paymentDebtSelection: { updateMany: jest.fn() },
      refund: {
        aggregate: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      chargeBatch: {
        count: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      ledgerEntry: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      expense: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
      },
    };
    repo = new FinanceRepository(prisma as unknown as PrismaService);
  });

  describe('sequential monthly payment selection', () => {
    const batch = (overrides: Record<string, unknown> = {}) => ({
      buildingId: 'b1',
      title: 'Monthly charge',
      description: null,
      kind: 'MONTHLY',
      seriesId: 'series-1',
      periodStart: new Date('2026-08-23T00:00:00.000Z'),
      status: 'ISSUED',
      fundId: 'fund-1',
      fund: { id: 'fund-1', name: 'Current', type: 'CURRENT' },
      ...overrides,
    });

    it('returns stable direct predecessor dependencies for later periods', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([
        {
          id: 'sep',
          unitId: 'u1',
          amount: 100,
          paidAmount: 0,
          createdAt: new Date('2026-08-23T00:00:00.000Z'),
          chargeBatch: batch(),
          debtSelections: [],
        },
        {
          id: 'oct',
          unitId: 'u1',
          amount: 110,
          paidAmount: 0,
          createdAt: new Date('2026-09-23T00:00:00.000Z'),
          chargeBatch: batch({ periodStart: new Date('2026-09-23T00:00:00.000Z') }),
          debtSelections: [],
        },
        {
          id: 'nov',
          unitId: 'u1',
          amount: 120,
          paidAmount: 0,
          createdAt: new Date('2026-10-23T00:00:00.000Z'),
          chargeBatch: batch({ periodStart: new Date('2026-10-23T00:00:00.000Z') }),
          debtSelections: [],
        },
      ]);
      prisma.adjustment.findMany.mockResolvedValue([]);

      await expect(repo.listSelectableObligations('u1')).resolves.toMatchObject([
        { obligationId: 'CHARGE_ITEM:sep', selectable: true, blockedByObligationId: null },
        {
          obligationId: 'CHARGE_ITEM:oct',
          selectable: false,
          unselectableReason: 'OLDER_MONTHLY_OBLIGATION_REQUIRED',
          blockedByObligationId: 'CHARGE_ITEM:sep',
        },
        {
          obligationId: 'CHARGE_ITEM:nov',
          selectable: false,
          unselectableReason: 'OLDER_MONTHLY_OBLIGATION_REQUIRED',
          blockedByObligationId: 'CHARGE_ITEM:oct',
        },
      ]);
    });

    it('rejects bypassing an ACTIVE-reserved monthly predecessor', async () => {
      const first = {
        id: 'sep',
        unitId: 'u1',
        amount: 100,
        paidAmount: 0,
        chargeBatch: batch(),
        debtSelections: [{ id: 'reservation-1' }],
      };
      const second = {
        id: 'oct',
        unitId: 'u1',
        amount: 110,
        paidAmount: 0,
        chargeBatch: batch({ periodStart: new Date('2026-09-23T00:00:00.000Z') }),
        debtSelections: [],
      };
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.chargeItem.findMany
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([first, second]);
      prisma.adjustment.findMany.mockResolvedValue([]);

      await expect(
        repo.createExplicitPayment({
          buildingId: 'b1',
          unitId: 'u1',
          payerId: 'person-1',
          method: 'CASH',
          idempotencyKey: 'cannot-bypass',
          targets: [{ type: 'CHARGE_ITEM', id: 'oct' }],
        }),
      ).rejects.toThrow('Monthly obligations must be selected oldest first without gaps.');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('classified charge fund race guard', () => {
    const params = {
      buildingId: 'b1',
      fundId: 'fund-1',
      title: 'Repair',
      calculationMethod: 'FIXED' as const,
      kind: 'REPAIR' as const,
      expectedFundType: 'RENOVATION' as const,
      createdById: 'person-1',
      items: [{ unitId: 'unit-1', amount: 10_000 }],
    };

    it('locks and rechecks the active compatible fund before persisting', async () => {
      prisma.chargeBatch.create.mockResolvedValue({ id: 'batch-1' });
      await repo.createChargeBatch(params);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.chargeBatch.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a concurrently deactivated or retyped fund before persistence', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(repo.createChargeBatch(params)).rejects.toBeInstanceOf(ConflictError);
      expect(prisma.chargeBatch.create).not.toHaveBeenCalled();
    });
  });

  describe('approvePayment — oldest-debt-first allocation order (ChargeItems, then Adjustments, then CreditBalance)', () => {
    it('allocates across ChargeItems oldest-due-first until the payment is exhausted, writing one PaymentAllocation row per item touched', async () => {
      prisma.payment.update.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
      prisma.chargeItem.findMany.mockResolvedValue([
        {
          id: 'item-old',
          amount: 100_000,
          paidAmount: 0,
          chargeBatch: { dueDate: new Date('2026-01-01') },
        },
        {
          id: 'item-new',
          amount: 100_000,
          paidAmount: 0,
          chargeBatch: { dueDate: new Date('2026-02-01') },
        },
      ]);
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.chargeItem.update.mockResolvedValue({});
      prisma.paymentAllocation.create.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await repo.approvePayment({
        paymentId: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 150_000,
        actorId: 'actor-1',
      });

      // item-old (due first) fully settled: 100_000 applied.
      expect(prisma.paymentAllocation.create).toHaveBeenNthCalledWith(1, {
        data: { paymentId: 'pay-1', chargeItemId: 'item-old', amount: 100_000 },
      });
      expect(prisma.chargeItem.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'item-old' },
        data: { paidAmount: 100_000, status: 'PAID' },
      });
      // item-new (due later) gets only the 50_000 remainder, stays PARTIALLY_PAID.
      expect(prisma.paymentAllocation.create).toHaveBeenNthCalledWith(2, {
        data: { paymentId: 'pay-1', chargeItemId: 'item-new', amount: 50_000 },
      });
      expect(prisma.chargeItem.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'item-new' },
        data: { paidAmount: 50_000, status: 'PARTIALLY_PAID' },
      });
      // Fully exhausted — never touches Adjustments or CreditBalance.
      expect(prisma.adjustment.findMany).not.toHaveBeenCalled();
      expect(prisma.creditBalance.upsert).not.toHaveBeenCalled();
      // Single cash-moving ledger entry for the FULL payment amount, and Fund.balance bumped by it.
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'PAYMENT',
          direction: 'CREDIT',
          amount: 150_000,
        }),
      });
      expect(prisma.fund.update).toHaveBeenCalledWith({
        where: { id: 'fund-1' },
        data: { balance: { increment: 150_000 } },
      });
    });

    it('applies any remainder after ChargeItems to outstanding positive Adjustments, oldest-created-first (ADR-053)', async () => {
      prisma.payment.update.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
      prisma.chargeItem.findMany.mockResolvedValue([]); // nothing outstanding
      prisma.adjustment.findMany.mockResolvedValue([
        { id: 'adj-old', amount: 30_000, paidAmount: 0, createdAt: new Date('2026-01-01') },
        { id: 'adj-new', amount: 30_000, paidAmount: 0, createdAt: new Date('2026-02-01') },
      ]);
      prisma.adjustment.update.mockResolvedValue({});
      prisma.paymentAllocation.create.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await repo.approvePayment({
        paymentId: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 40_000,
        actorId: 'actor-1',
      });

      expect(prisma.paymentAllocation.create).toHaveBeenNthCalledWith(1, {
        data: { paymentId: 'pay-1', adjustmentId: 'adj-old', amount: 30_000 },
      });
      expect(prisma.paymentAllocation.create).toHaveBeenNthCalledWith(2, {
        data: { paymentId: 'pay-1', adjustmentId: 'adj-new', amount: 10_000 },
      });
      expect(prisma.creditBalance.upsert).not.toHaveBeenCalled();
    });

    it('banks any leftover beyond ChargeItems and Adjustments as CreditBalance (overpayment)', async () => {
      prisma.payment.update.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
      prisma.chargeItem.findMany.mockResolvedValue([]);
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.creditBalance.upsert.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await repo.approvePayment({
        paymentId: 'pay-1',
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        amount: 25_000,
        actorId: 'actor-1',
      });

      expect(prisma.creditBalance.upsert).toHaveBeenCalledWith({
        where: { unitId: 'u1' },
        create: { unitId: 'u1', buildingId: 'b1', balance: 25_000 },
        update: { balance: { increment: 25_000 } },
      });
    });
  });

  describe('reversePayment — allocation rollback', () => {
    it('rolls back a ChargeItem allocation (decrementing paidAmount, recomputing status) and writes a REVERSAL ledger entry that decrements Fund.balance', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 40_000,
      });
      prisma.payment.update.mockResolvedValue({ id: 'pay-1', status: 'REVERSED', unitId: 'u1' });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 40_000 } });
      prisma.paymentAllocation.findMany.mockResolvedValue([
        { chargeItemId: 'item-1', adjustmentId: null, amount: 40_000 },
      ]);
      prisma.chargeItem.findUnique.mockResolvedValue({
        id: 'item-1',
        amount: 100_000,
        paidAmount: 40_000,
      });
      prisma.chargeItem.update.mockResolvedValue({});
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await repo.reversePayment({
        paymentId: 'pay-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 40_000,
        actorId: 'actor-1',
      });

      expect(prisma.chargeItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { paidAmount: 0, status: 'UNPAID' },
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'REVERSAL',
          direction: 'DEBIT',
          amount: 40_000,
        }),
      });
      expect(prisma.fund.update).toHaveBeenCalledWith({
        where: { id: 'fund-1' },
        data: { balance: { decrement: 40_000 } },
      });
    });

    it('rolls back an Adjustment allocation (never touching ChargeItem) when the allocation row targets an Adjustment', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 15_000,
      });
      prisma.payment.update.mockResolvedValue({ id: 'pay-1', status: 'REVERSED', unitId: 'u1' });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 15_000 } });
      prisma.paymentAllocation.findMany.mockResolvedValue([
        { chargeItemId: null, adjustmentId: 'adj-1', amount: 15_000 },
      ]);
      prisma.adjustment.findUnique.mockResolvedValue({ id: 'adj-1', paidAmount: 15_000 });
      prisma.adjustment.update.mockResolvedValue({});
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await repo.reversePayment({
        paymentId: 'pay-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 15_000,
        actorId: 'actor-1',
      });

      expect(prisma.adjustment.update).toHaveBeenCalledWith({
        where: { id: 'adj-1' },
        data: { paidAmount: 0 },
      });
      expect(prisma.chargeItem.update).not.toHaveBeenCalled();
    });

    it('rejects an entirely credit-producing payment before any reversal mutation', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 1_000_000,
      });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: null } });

      await expect(
        repo.reversePayment({
          paymentId: 'pay-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 1_000_000,
          actorId: 'actor-1',
        }),
      ).rejects.toThrow('Payments that generated unit credit cannot be reversed in MVP.');

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.paymentAllocation.findMany).not.toHaveBeenCalled();
      expect(prisma.chargeItem.update).not.toHaveBeenCalled();
      expect(prisma.adjustment.update).not.toHaveBeenCalled();
      expect(prisma.creditBalance.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('rejects a partially allocated payment based on its 400,000 historical credit', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 1_000_000,
      });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 600_000 } });

      await expect(
        repo.reversePayment({
          paymentId: 'pay-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 1_000_000,
          actorId: 'actor-1',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.paymentAllocation.findMany).not.toHaveBeenCalled();
      expect(prisma.creditBalance.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('fails closed when allocation history exceeds the authoritative payment amount', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 1_000_000,
      });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 1_000_001 } });

      await expect(
        repo.reversePayment({
          paymentId: 'pay-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 1_000_000,
          actorId: 'actor-1',
        }),
      ).rejects.toThrow('Payment allocation history exceeds the payment amount.');

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.paymentAllocation.findMany).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('orders candidate read, advisory lock, authoritative Payment read, allocation aggregate, and only then reversal mutations', async () => {
      const callOrder: string[] = [];
      prisma.payment.findUnique.mockImplementation(() => {
        callOrder.push('read-payment');
        return Promise.resolve({
          id: 'pay-1',
          status: 'APPROVED',
          unitId: 'u1',
          amount: 40_000,
        });
      });
      prisma.$executeRaw.mockImplementation(() => {
        callOrder.push('lock');
        return Promise.resolve(undefined);
      });
      prisma.paymentAllocation.aggregate.mockImplementation(() => {
        callOrder.push('aggregate-allocations');
        return Promise.resolve({ _sum: { amount: 40_000 } });
      });
      prisma.payment.update.mockImplementation(() => {
        callOrder.push('mutate');
        return Promise.resolve({ id: 'pay-1', status: 'REVERSED', unitId: 'u1' });
      });
      prisma.paymentAllocation.findMany.mockResolvedValue([]);
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await repo.reversePayment({
        paymentId: 'pay-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 40_000,
        actorId: 'actor-1',
      });

      // pre-lock findUnique (for unitId) -> lock -> post-lock findUnique
      // (authoritative re-read) -> only then the state-changing update.
      expect(callOrder).toEqual([
        'read-payment',
        'lock',
        'read-payment',
        'aggregate-allocations',
        'mutate',
      ]);
    });

    it('rejects reversing a payment that is no longer APPROVED by the time the lock is held (lost the race to a concurrent reverse/refund) and mutates nothing', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce({ id: 'pay-1', status: 'APPROVED', unitId: 'u1' }) // pre-lock candidate read
        .mockResolvedValueOnce({ id: 'pay-1', status: 'REVERSED', unitId: 'u1' }); // post-lock authoritative re-read

      await expect(
        repo.reversePayment({
          paymentId: 'pay-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 40_000,
          actorId: 'actor-1',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('rejects reversing a payment that no longer exists (pre-lock candidate read) without acquiring the lock', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);

      await expect(
        repo.reversePayment({
          paymentId: 'missing',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 40_000,
          actorId: 'actor-1',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('createRefund — concurrency-safe lock + post-lock re-check (FIN-MVP-GAP-03B)', () => {
    const params = {
      paymentId: 'pay-1',
      unitId: 'u1',
      buildingId: 'b1',
      fundId: 'fund-1',
      amount: 100_000,
      paymentAmount: 100_000,
      reason: 'resident requested a refund',
      createdById: 'actor-1',
    };

    beforeEach(() => {
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 100_000 } });
    });

    it('orders the advisory lock, authoritative Payment read, and allocation aggregate before rejecting an allocated refund with zero mutations', async () => {
      const callOrder: string[] = [];
      prisma.$executeRaw.mockImplementation(() => {
        callOrder.push('lock');
        return Promise.resolve(undefined);
      });
      prisma.payment.findUnique.mockImplementation(() => {
        callOrder.push('read-payment');
        return Promise.resolve({ id: 'pay-1', status: 'APPROVED', unitId: 'u1', amount: 100_000 });
      });
      prisma.paymentAllocation.aggregate.mockImplementation(() => {
        callOrder.push('aggregate-allocations');
        return Promise.resolve({ _sum: { amount: 100_000 } });
      });
      await expect(repo.createRefund(params)).rejects.toThrow(
        'Payments allocated to obligations cannot be refunded in MVP.',
      );

      expect(callOrder).toEqual(['lock', 'read-payment', 'aggregate-allocations']);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.refund.findMany).not.toHaveBeenCalled();
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('rejects a zero-allocation payment that generated credit before any refund mutation', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 100_000,
      });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: null } });

      await expect(repo.createRefund(params)).rejects.toThrow(
        'Payments that generated unit credit cannot be refunded in MVP.',
      );

      expect(prisma.refund.findMany).not.toHaveBeenCalled();
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('rejects a partially allocated payment based on its historical credit amount', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 1_000_000,
      });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 600_000 } });

      await expect(
        repo.createRefund({ ...params, amount: 1_000_000, paymentAmount: 1_000_000 }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('fails closed when allocation history exceeds the authoritative payment amount', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 100_000,
      });
      prisma.paymentAllocation.aggregate.mockResolvedValue({ _sum: { amount: 100_001 } });

      await expect(repo.createRefund(params)).rejects.toThrow(
        'Payment allocation history exceeds the payment amount.',
      );

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('rejects a fully allocated non-credit-producing payment before every refund mutation', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 100_000,
      });
      await expect(repo.createRefund(params)).rejects.toThrow(
        'Payments allocated to obligations cannot be refunded in MVP.',
      );

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('also rejects a partial refund request for a fully allocated payment', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 100_000,
      });
      await expect(
        repo.createRefund({ ...params, amount: 40_000, paymentAmount: 100_000 }),
      ).rejects.toThrow('Payments allocated to obligations cannot be refunded in MVP.');

      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('rejects refunding a payment that is no longer APPROVED by the time the lock is held (lost the race to a concurrent reverse/refund) and creates nothing', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'REVERSED',
        unitId: 'u1',
      });

      await expect(repo.createRefund(params)).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.refund.findMany).not.toHaveBeenCalled();
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('applies the allocated-payment guard before any legacy existing-refund lookup', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        status: 'APPROVED',
        unitId: 'u1',
        amount: 100_000,
      });
      await expect(repo.createRefund(params)).rejects.toThrow(
        'Payments allocated to obligations cannot be refunded in MVP.',
      );

      expect(prisma.refund.findMany).not.toHaveBeenCalled();
      expect(prisma.refund.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });
  });

  describe('createAdjustment — waiver allocation (negative amount)', () => {
    it('applies a negative (waiver) adjustment oldest-debt-first across outstanding ChargeItems, never creating a PaymentAllocation row', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-1' });
      prisma.chargeItem.findMany.mockResolvedValue([
        {
          id: 'item-1',
          amount: 50_000,
          paidAmount: 0,
          chargeBatch: { dueDate: new Date('2026-01-01') },
        },
      ]);
      prisma.chargeItem.update.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.createAdjustment({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: -20_000,
        reason: 'goodwill waiver',
        createdById: 'actor-1',
      });

      expect(prisma.chargeItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { paidAmount: 20_000, status: 'PARTIALLY_PAID' },
      });
      expect(prisma.paymentAllocation.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'ADJUSTMENT',
          direction: 'CREDIT',
          amount: 20_000,
        }),
      });
    });

    it('does not create CreditBalance when a waiver exceeds total outstanding debt (waiving is not the same as receiving cash)', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-1' });
      prisma.chargeItem.findMany.mockResolvedValue([
        {
          id: 'item-1',
          amount: 10_000,
          paidAmount: 0,
          chargeBatch: { dueDate: new Date('2026-01-01') },
        },
      ]);
      prisma.chargeItem.update.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.createAdjustment({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: -50_000, // waives far more than the 10_000 outstanding
        reason: 'large waiver',
        createdById: 'actor-1',
      });

      expect(prisma.chargeItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { paidAmount: 10_000, status: 'PAID' },
      });
      expect(prisma.creditBalance.upsert).not.toHaveBeenCalled();
      expect(prisma.creditBalance.update).not.toHaveBeenCalled();
    });

    it('a positive (debt-adding) adjustment never touches any ChargeItem', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-1' });
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.createAdjustment({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 25_000,
        reason: 'late fee',
        createdById: 'actor-1',
      });

      expect(prisma.chargeItem.findMany).not.toHaveBeenCalled();
      expect(prisma.chargeItem.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'ADJUSTMENT',
          direction: 'DEBIT',
          amount: 25_000,
        }),
      });
    });
  });

  describe('applyOpeningBalanceCorrection (Finance Correction Pass)', () => {
    it('computes delta from the authoritative aggregate after locking and rejects a zero-delta retry', async () => {
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 100_000 }]);

      await expect(
        repo.applyOpeningBalanceCorrection({
          unitId: 'u1',
          buildingId: 'b1',
          fundId: 'fund-1',
          targetBalance: 100_000,
          reason: 'concurrent retry',
          createdById: 'actor-1',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.$executeRaw.mock.calls[0][1]).toBe('finance-payment:u1');
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.adjustment.findMany.mock.invocationCallOrder[0],
      );
      expect(prisma.adjustment.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('a positive delta just creates an outstanding Adjustment — touches no ChargeItem and no prior correction', async () => {
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-new' });
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.applyOpeningBalanceCorrection({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        targetBalance: 500_000,
        reason: 'Initial ledger migration',
        createdById: 'actor-1',
      });

      expect(prisma.adjustment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          unitId: 'u1',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 500_000,
          reason: 'Initial ledger migration',
          createdById: 'actor-1',
          sourceType: 'OPENING_BALANCE_CORRECTION',
        }),
      });
      expect(prisma.adjustment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.chargeItem.findMany).not.toHaveBeenCalled();
      expect(prisma.creditBalance.upsert).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'ADJUSTMENT',
          direction: 'DEBIT',
          amount: 500_000,
        }),
      });
    });

    it("a negative delta waives the unit's own prior OPENING_BALANCE_CORRECTION Adjustments oldest-first — never touching a ChargeItem, unlike createAdjustment", async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-waiver' });
      prisma.adjustment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 'adj-old', amount: 500_000, paidAmount: 0, createdAt: new Date('2026-01-01') },
        { id: 'adj-new', amount: 50_000, paidAmount: 0, createdAt: new Date('2026-02-01') },
      ]);
      prisma.adjustment.update.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.applyOpeningBalanceCorrection({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        targetBalance: -200_000,
        reason: 'Overstated originally',
        createdById: 'actor-1',
      });

      // Queried only the unit's own OPENING_BALANCE_CORRECTION positive
      // Adjustments (excluding the just-created waiver row itself) — never
      // ChargeItems, which `createAdjustment`'s own waiver loop would hit.
      expect(prisma.adjustment.findMany).toHaveBeenLastCalledWith({
        where: {
          unitId: 'u1',
          sourceType: 'OPENING_BALANCE_CORRECTION',
          amount: { gt: 0 },
          id: { not: 'adj-waiver' },
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(prisma.chargeItem.findMany).not.toHaveBeenCalled();
      expect(prisma.chargeItem.update).not.toHaveBeenCalled();
      // Oldest prior correction (adj-old, 500_000 outstanding) fully absorbs
      // the 200_000 waiver; adj-new is never touched.
      expect(prisma.adjustment.update).toHaveBeenCalledTimes(1);
      expect(prisma.adjustment.update).toHaveBeenCalledWith({
        where: { id: 'adj-old' },
        data: { paidAmount: 200_000 },
      });
      expect(prisma.creditBalance.upsert).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'ADJUSTMENT',
          direction: 'CREDIT',
          amount: 200_000,
        }),
      });
    });

    it('spills across multiple prior corrections oldest-first once the first is exhausted', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-waiver' });
      prisma.adjustment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 'adj-old', amount: 200_000, paidAmount: 0, createdAt: new Date('2026-01-01') },
        { id: 'adj-new', amount: 50_000, paidAmount: 0, createdAt: new Date('2026-02-01') },
      ]);
      prisma.adjustment.update.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.applyOpeningBalanceCorrection({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        targetBalance: -230_000,
        reason: 'Large downward correction',
        createdById: 'actor-1',
      });

      expect(prisma.adjustment.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'adj-old' },
        data: { paidAmount: 200_000 },
      });
      expect(prisma.adjustment.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'adj-new' },
        data: { paidAmount: 30_000 },
      });
      expect(prisma.creditBalance.upsert).not.toHaveBeenCalled();
    });

    it("routes any waiver amount beyond the unit's own prior corrections into CreditBalance — unlike createAdjustment, which discards excess", async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-waiver' });
      prisma.adjustment.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'adj-old', amount: 100_000, paidAmount: 0, createdAt: new Date('2026-01-01') },
        ]);
      prisma.adjustment.update.mockResolvedValue({});
      prisma.creditBalance.upsert.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.applyOpeningBalanceCorrection({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        targetBalance: -150_000, // 100_000 owed via prior corrections, 50_000 becomes credit
        reason: 'Correcting to a credit balance',
        createdById: 'actor-1',
      });

      expect(prisma.adjustment.update).toHaveBeenCalledWith({
        where: { id: 'adj-old' },
        data: { paidAmount: 100_000 },
      });
      expect(prisma.creditBalance.upsert).toHaveBeenCalledWith({
        where: { unitId: 'u1' },
        create: { unitId: 'u1', buildingId: 'b1', balance: 50_000 },
        update: { balance: { increment: 50_000 } },
      });
    });

    it('with no prior corrections at all, a negative delta becomes pure CreditBalance (first-ever correction is straight to a credit)', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-waiver' });
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.creditBalance.upsert.mockResolvedValue({});
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.applyOpeningBalanceCorrection({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        targetBalance: -150_000,
        reason: 'Actually a credit',
        createdById: 'actor-1',
      });

      expect(prisma.adjustment.update).not.toHaveBeenCalled();
      expect(prisma.creditBalance.upsert).toHaveBeenCalledWith({
        where: { unitId: 'u1' },
        create: { unitId: 'u1', buildingId: 'b1', balance: 150_000 },
        update: { balance: { increment: 150_000 } },
      });
    });
  });

  describe('getUnitDebt — confirmed debt / pending payment / remaining payable (Finance QA correction)', () => {
    it('no pending payment: remainingPayable equals confirmed net debt', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([]);

      const debt = await repo.getUnitDebt('u1');

      expect(debt).toEqual({
        chargeItemDebt: 35_000_000,
        adjustmentDebt: 3_000,
        totalDebt: 35_003_000,
        creditBalance: 0,
        pendingPaymentAmount: 0,
        remainingPayable: 35_003_000,
      });
    });

    it('partial pending payment reduces remainingPayable but not confirmed debt', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([{ amount: 10_000_000 }]);

      const debt = await repo.getUnitDebt('u1');

      expect(debt.totalDebt).toBe(35_003_000);
      expect(debt.pendingPaymentAmount).toBe(10_000_000);
      expect(debt.remainingPayable).toBe(25_003_000);
      // Queried only PENDING_APPROVAL — the query shape itself is what
      // excludes REJECTED/APPROVED/REVERSED/REFUNDED, not a JS filter.
      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { unitId: 'u1', status: 'PENDING_APPROVAL' },
        select: { amount: true },
      });
    });

    it('full pending payment brings remainingPayable to exactly 0 while confirmed debt is unchanged', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([{ amount: 35_003_000 }]);

      const debt = await repo.getUnitDebt('u1');

      expect(debt.totalDebt).toBe(35_003_000);
      expect(debt.remainingPayable).toBe(0);
    });

    it('multiple legitimate pending payments sum correctly', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([
        { amount: 10_000_000 },
        { amount: 5_000_000 },
        { amount: 20_003_000 },
      ]);

      const debt = await repo.getUnitDebt('u1');

      expect(debt.pendingPaymentAmount).toBe(35_003_000);
      expect(debt.remainingPayable).toBe(0);
    });

    it('remainingPayable never goes negative when pending exceeds confirmed net debt', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([]);
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      // Shouldn't happen once the createPayment validation below is in
      // place, but the read side must stay defensively floored at 0
      // regardless (e.g. pre-existing dev data, or a manual override that
      // legitimately exceeded it).
      prisma.payment.findMany.mockResolvedValue([{ amount: 5_000 }]);

      const debt = await repo.getUnitDebt('u1');

      expect(debt.remainingPayable).toBe(0);
    });

    it('nets out an existing CreditBalance before reserving pending amounts (zero-debt/credit case stays intact)', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([]);
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.creditBalance.findUnique.mockResolvedValue({ unitId: 'u1', balance: 50_000 });
      prisma.payment.findMany.mockResolvedValue([]);

      const debt = await repo.getUnitDebt('u1');

      expect(debt.totalDebt).toBe(0);
      expect(debt.creditBalance).toBe(50_000);
      expect(debt.remainingPayable).toBe(0);
    });
  });

  describe('listUnitDebtSummaries — bounded set-based parity', () => {
    it('matches the single-unit snapshot for the same finance state', async () => {
      const chargeItems = [{ unitId: 'u1', amount: 1000, paidAmount: 200 }];
      const adjustments = [{ unitId: 'u1', amount: 100, paidAmount: 0 }];
      const pendingPayments = [{ unitId: 'u1', amount: 250 }];
      prisma.chargeItem.findMany.mockResolvedValue(chargeItems);
      prisma.adjustment.findMany.mockResolvedValue(adjustments);
      prisma.creditBalance.findUnique.mockResolvedValue({ balance: 50 });
      prisma.creditBalance.findMany.mockResolvedValue([{ unitId: 'u1', balance: 50 }]);
      prisma.payment.findMany.mockResolvedValue(pendingPayments);
      prisma.unit.findMany.mockResolvedValue([{ id: 'u1' }]);
      prisma.unit.count.mockResolvedValue(1);

      const single = await repo.getUnitDebt('u1');
      const bulk = await repo.listUnitDebtSummaries('b1', {
        skip: 0,
        take: 20,
      });

      expect(bulk.items[0]).toEqual({
        unitId: 'u1',
        remainingPayable: single.remainingPayable,
      });
    });

    it('preserves snapshot semantics for multiple units with fixed query count', async () => {
      prisma.unit.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
      prisma.unit.count.mockResolvedValue(3);
      prisma.chargeItem.findMany.mockResolvedValue([
        { unitId: 'u1', amount: 1000, paidAmount: 200 },
        { unitId: 'u2', amount: 500, paidAmount: 500 },
      ]);
      prisma.adjustment.findMany.mockResolvedValue([
        { unitId: 'u1', amount: 100, paidAmount: 0 },
        { unitId: 'u2', amount: 300, paidAmount: 50 },
      ]);
      prisma.creditBalance.findMany.mockResolvedValue([
        { unitId: 'u1', balance: 50 },
        { unitId: 'u2', balance: 1000 },
      ]);
      prisma.payment.findMany.mockResolvedValue([{ unitId: 'u1', amount: 250 }]);

      await expect(repo.listUnitDebtSummaries('b1', { skip: 0, take: 20 })).resolves.toEqual({
        items: [
          { unitId: 'u1', remainingPayable: 600 },
          { unitId: 'u2', remainingPayable: 0 },
          { unitId: 'u3', remainingPayable: 0 },
        ],
        total: 3,
      });
      expect(prisma.chargeItem.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.adjustment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.creditBalance.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    });

    it('does not issue debt queries for an empty page', async () => {
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.unit.count.mockResolvedValue(0);
      await expect(repo.listUnitDebtSummaries('b1', { skip: 0, take: 20 })).resolves.toEqual({
        items: [],
        total: 0,
      });
      expect(prisma.chargeItem.findMany).not.toHaveBeenCalled();
      expect(prisma.adjustment.findMany).not.toHaveBeenCalled();
      expect(prisma.creditBalance.findMany).not.toHaveBeenCalled();
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('createPayment — remaining-payable validation & concurrency (Finance QA correction)', () => {
    it('accepts a non-manual amount at or under remaining payable', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.create.mockResolvedValue({ id: 'pay-1', status: 'PENDING_APPROVAL' });

      const result = await repo.createPayment({
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        payerId: 'payer-1',
        idempotencyKey: 'idem-1',
        amount: 35_003_000,
        method: 'CASH',
        isManualAmount: false,
      });

      expect(result).toEqual({ id: 'pay-1', status: 'PENDING_APPROVAL' });
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 35_003_000, status: 'PENDING_APPROVAL' }),
      });
      // Per-unit advisory lock acquired before the validating read.
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('rejects a non-manual amount that exceeds remaining payable — the exact duplicate-tap bug this closes', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      // A payment for the FULL debt is already pending — remainingPayable is 0.
      prisma.payment.findMany.mockResolvedValue([{ amount: 35_003_000 }]);

      await expect(
        repo.createPayment({
          buildingId: 'b1',
          unitId: 'u1',
          fundId: 'fund-1',
          payerId: 'payer-1',
          idempotencyKey: 'idem-2',
          amount: 35_003_000,
          method: 'CASH',
          isManualAmount: false,
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('rejects a non-manual amount that exceeds a PARTIAL remaining payable', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([{ amount: 35_000_000, paidAmount: 0 }]);
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 3_000, paidAmount: 0 }]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      // 10_000_000 already pending -> remainingPayable is 25_003_000.
      prisma.payment.findMany.mockResolvedValue([{ amount: 10_000_000 }]);

      await expect(
        repo.createPayment({
          buildingId: 'b1',
          unitId: 'u1',
          fundId: 'fund-1',
          payerId: 'payer-1',
          idempotencyKey: 'idem-3',
          amount: 25_003_001,
          method: 'CASH',
          isManualAmount: false,
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('a manual amount bypasses the remaining-payable ceiling even when remaining payable is 0 (zero-debt/credit manual entry stays valid)', async () => {
      prisma.chargeItem.findMany.mockResolvedValue([]);
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.create.mockResolvedValue({ id: 'pay-1', status: 'PENDING_APPROVAL' });

      const result = await repo.createPayment({
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        payerId: 'payer-1',
        idempotencyKey: 'idem-4',
        amount: 20_000,
        method: 'CASH',
        isManualAmount: true,
      });

      expect(result).toEqual({ id: 'pay-1', status: 'PENDING_APPROVAL' });
      // Manual mode skips the validating read entirely — never even
      // queries ChargeItem/Adjustment/CreditBalance/Payment to check a
      // ceiling that doesn't apply.
      expect(prisma.chargeItem.findMany).not.toHaveBeenCalled();
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 20_000 }),
      });
    });

    it('acquires the per-unit advisory lock before reading the debt snapshot, serializing concurrent reports for the same unit', async () => {
      const callOrder: string[] = [];
      prisma.$executeRaw.mockImplementation(() => {
        callOrder.push('lock');
        return Promise.resolve(undefined);
      });
      prisma.chargeItem.findMany.mockImplementation(() => {
        callOrder.push('read-debt');
        return Promise.resolve([{ amount: 10_000, paidAmount: 0 }]);
      });
      prisma.adjustment.findMany.mockResolvedValue([]);
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.create.mockImplementation(() => {
        callOrder.push('create');
        return Promise.resolve({ id: 'pay-1', status: 'PENDING_APPROVAL' });
      });

      await repo.createPayment({
        buildingId: 'b1',
        unitId: 'u1',
        fundId: 'fund-1',
        payerId: 'payer-1',
        idempotencyKey: 'idem-5',
        amount: 10_000,
        method: 'CASH',
        isManualAmount: false,
      });

      expect(callOrder).toEqual(['lock', 'read-debt', 'create']);
      // Locked per-unit (hashtext over a unit-scoped key), inside the same
      // transaction as the read+write it protects.
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('getUnitOpeningBalanceCorrectionTotal (Finance Correction Pass)', () => {
    it('returns 0 for a unit with no OPENING_BALANCE_CORRECTION adjustments', async () => {
      prisma.adjustment.findMany.mockResolvedValue([]);

      const total = await repo.getUnitOpeningBalanceCorrectionTotal('u1');

      expect(total).toBe(0);
      expect(prisma.adjustment.findMany).toHaveBeenCalledWith({
        where: { unitId: 'u1', sourceType: 'OPENING_BALANCE_CORRECTION' },
        select: { amount: true },
      });
    });

    it('sums every OPENING_BALANCE_CORRECTION adjustment recorded for the unit, positive and negative alike', async () => {
      prisma.adjustment.findMany.mockResolvedValue([
        { amount: 500_000 },
        { amount: -200_000 },
        { amount: 100_000 },
      ]);

      const total = await repo.getUnitOpeningBalanceCorrectionTotal('u1');

      expect(total).toBe(400_000);
    });

    it('never includes adjustments with a different sourceType (e.g. LATE_FEE) or plain manual adjustments — filtered entirely by the where clause, not by this method summing extra rows', async () => {
      // The where clause itself is what excludes LATE_FEE/manual rows —
      // this test documents that expectation by asserting the query shape
      // (above) rather than re-deriving Prisma's own filtering behavior.
      prisma.adjustment.findMany.mockResolvedValue([{ amount: 50_000 }]);

      const total = await repo.getUnitOpeningBalanceCorrectionTotal('u1');

      expect(total).toBe(50_000);
    });
  });

  describe('shared unit Finance serialization', () => {
    it('takes the unit lock before a negative adjustment reads outstanding items', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-1' });
      prisma.chargeItem.findMany.mockResolvedValue([]);
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.createAdjustment({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: -100,
        reason: 'waiver',
        createdById: 'actor-1',
      });

      expect(prisma.$executeRaw.mock.calls[0][1]).toBe('finance-payment:u1');
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.chargeItem.findMany.mock.invocationCallOrder[0],
      );
    });

    it('takes the same unit lock for a positive adjustment', async () => {
      prisma.adjustment.create.mockResolvedValue({ id: 'adj-1' });
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.createAdjustment({
        unitId: 'u1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 100,
        reason: 'fee',
        createdById: 'actor-1',
      });

      expect(prisma.$executeRaw.mock.calls[0][1]).toBe('finance-payment:u1');
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.adjustment.create.mock.invocationCallOrder[0],
      );
    });

    it('cancels only after sorted unique locks, authoritative reread, and status CAS', async () => {
      prisma.chargeBatch.findUnique
        .mockResolvedValueOnce({
          chargeItems: [{ unitId: 'u2' }, { unitId: 'u1' }, { unitId: 'u2' }],
        })
        .mockResolvedValueOnce({
          id: 'batch-1',
          buildingId: 'b1',
          status: 'ISSUED',
          chargeItems: [{ paidAmount: 0 }, { paidAmount: 0 }],
        });
      prisma.chargeBatch.updateMany.mockResolvedValue({ count: 1 });
      prisma.chargeBatch.findUniqueOrThrow.mockResolvedValue({
        id: 'batch-1',
        status: 'CANCELLED',
      });

      const result = await repo.cancelChargeBatch({ chargeBatchId: 'batch-1', buildingId: 'b1' });

      expect(prisma.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
        'finance-payment:u1',
        'finance-payment:u2',
      ]);
      expect(prisma.chargeBatch.updateMany).toHaveBeenCalledWith({
        where: { id: 'batch-1', status: 'ISSUED' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      expect(result).toEqual({ id: 'batch-1', status: 'CANCELLED' });
    });

    it('rejects cancellation after the locked reread finds paid state, without CAS', async () => {
      prisma.chargeBatch.findUnique
        .mockResolvedValueOnce({ chargeItems: [{ unitId: 'u1' }] })
        .mockResolvedValueOnce({
          id: 'batch-1',
          buildingId: 'b1',
          status: 'ISSUED',
          chargeItems: [{ paidAmount: 1 }],
        });

      await expect(
        repo.cancelChargeBatch({ chargeBatchId: 'batch-1', buildingId: 'b1' }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(prisma.chargeBatch.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('issueChargeBatch — credit auto-apply', () => {
    it('locks unique affected units once in deterministic lexical order before the authoritative reread', async () => {
      prisma.chargeBatch.findUnique
        .mockResolvedValueOnce({
          chargeItems: [{ unitId: 'unit-c' }, { unitId: 'unit-a' }, { unitId: 'unit-c' }],
        })
        .mockResolvedValueOnce({
          id: 'batch-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          totalAmount: 300,
          status: 'DRAFT',
          chargeItems: [],
        });
      prisma.chargeBatch.updateMany.mockResolvedValue({ count: 1 });
      prisma.chargeBatch.findUniqueOrThrow.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });
      prisma.ledgerEntry.create.mockResolvedValue({});

      await expect(
        repo.issueChargeBatch({
          chargeBatchId: 'batch-1',
          buildingId: 'b1',
          fundId: 'stale-fund',
          totalAmount: 999,
          actorId: 'actor-1',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);

      expect(prisma.$executeRaw.mock.calls.map((call) => call[1])).toEqual([
        'finance-payment:unit-a',
        'finance-payment:unit-c',
      ]);
      expect(prisma.chargeBatch.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(
        prisma.$executeRaw.mock.invocationCallOrder[1],
      );
    });

    it('a DRAFT-to-ISSUED CAS loser creates no payer, credit, item, or ledger side effects', async () => {
      prisma.chargeBatch.findUnique
        .mockResolvedValueOnce({ chargeItems: [{ unitId: 'u1' }] })
        .mockResolvedValueOnce({
          id: 'batch-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          totalAmount: 100,
          status: 'DRAFT',
          chargeItems: [{ id: 'item-1', unitId: 'u1', amount: 100, paidAmount: 0 }],
        });
      prisma.chargeBatch.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repo.issueChargeBatch({
          chargeBatchId: 'batch-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          totalAmount: 100,
          actorId: 'actor-1',
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(prisma.chargeItem.update).not.toHaveBeenCalled();
      expect(prisma.chargeItem.createMany).not.toHaveBeenCalled();
      expect(prisma.creditBalance.findUnique).not.toHaveBeenCalled();
      expect(prisma.creditBalance.updateMany).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('applies an existing CreditBalance against the new ChargeItem, decrementing the credit and writing a CREDIT_APPLIED entry, before the final CHARGE entry', async () => {
      prisma.chargeItem.update.mockResolvedValue({});
      prisma.creditBalance.updateMany.mockResolvedValue({ count: 1 });
      prisma.ledgerEntry.create.mockResolvedValue({});
      const item = { id: 'item-1', unitId: 'u1', amount: 100_000, paidAmount: 0 };
      prisma.chargeBatch.findUnique
        .mockResolvedValueOnce({ chargeItems: [{ unitId: 'u1' }] })
        .mockResolvedValueOnce({
          id: 'batch-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          totalAmount: 100_000,
          status: 'DRAFT',
          chargeItems: [item],
        });
      prisma.chargeBatch.updateMany.mockResolvedValue({ count: 1 });
      prisma.chargeBatch.findUniqueOrThrow.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });
      prisma.creditBalance.findUnique.mockResolvedValue({ unitId: 'u1', balance: 30_000 });

      await repo.issueChargeBatch({
        chargeBatchId: 'batch-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        totalAmount: 100_000,
        actorId: 'actor-1',
      });

      expect(prisma.chargeItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { paidAmount: 30_000, status: 'PARTIALLY_PAID' },
      });
      expect(prisma.creditBalance.updateMany).toHaveBeenCalledWith({
        where: { unitId: 'u1', balance: { gte: 30_000 } },
        data: { balance: { decrement: 30_000 } },
      });
      expect(prisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({ entryType: 'CREDIT_APPLIED', amount: 30_000 }),
      });
      // The batch-level CHARGE entry always comes last, for the full totalAmount.
      expect(prisma.ledgerEntry.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ entryType: 'CHARGE', direction: 'DEBIT', amount: 100_000 }),
      });
    });

    it('skips credit application entirely when a unit has no CreditBalance row', async () => {
      const item = { id: 'item-1', unitId: 'u1', amount: 100_000, paidAmount: 0 };
      prisma.chargeBatch.findUnique
        .mockResolvedValueOnce({ chargeItems: [{ unitId: 'u1' }] })
        .mockResolvedValueOnce({
          id: 'batch-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          totalAmount: 100_000,
          status: 'DRAFT',
          chargeItems: [item],
        });
      prisma.chargeBatch.updateMany.mockResolvedValue({ count: 1 });
      prisma.chargeBatch.findUniqueOrThrow.mockResolvedValue({ id: 'batch-1', status: 'ISSUED' });
      prisma.creditBalance.findUnique.mockResolvedValue(null);
      prisma.ledgerEntry.create.mockResolvedValue({});

      await repo.issueChargeBatch({
        chargeBatchId: 'batch-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        totalAmount: 100_000,
        actorId: 'actor-1',
      });

      expect(prisma.chargeItem.update).not.toHaveBeenCalled();
      expect(prisma.creditBalance.updateMany).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listPayments — optional status filter (Backend ↔ Mobile Contract Alignment)', () => {
    it('omits status from the where clause when not provided (unchanged pre-existing behavior)', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await repo.listPayments('b1', { skip: 0, take: 20 });

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1' } }),
      );
      expect(prisma.payment.count).toHaveBeenCalledWith({ where: { buildingId: 'b1' } });
    });

    it('adds status to both the findMany and count where clauses when provided', async () => {
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p1', status: 'PENDING_APPROVAL', unit: { unitNumber: 'A12' } },
      ]);
      prisma.payment.count.mockResolvedValue(1);

      const result = await repo.listPayments('b1', { skip: 0, take: 20 }, 'PENDING_APPROVAL');

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { buildingId: 'b1', status: 'PENDING_APPROVAL' },
        }),
      );
      expect(prisma.payment.count).toHaveBeenCalledWith({
        where: { buildingId: 'b1', status: 'PENDING_APPROVAL' },
      });
      expect(result).toEqual({
        items: [{ id: 'p1', status: 'PENDING_APPROVAL', unitNumber: 'A12' }],
        total: 1,
      });
    });

    it('still orders by createdAt desc and honors skip/take with a status filter applied', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await repo.listPayments('b1', { skip: 40, take: 20 }, 'APPROVED');

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 40, take: 20 }),
      );
    });

    it('flattens the joined unit into unitNumber and strips the nested unit object (FIN-PAY-REVIEW-01B)', async () => {
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p1', unitId: 'unit-internal-id-1', unit: { unitNumber: '12' } },
      ]);
      prisma.payment.count.mockResolvedValue(1);

      const result = await repo.listPayments('b1', { skip: 0, take: 20 });

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { unit: { select: { unitNumber: true } } },
        }),
      );
      expect(result.items[0]).toEqual({
        id: 'p1',
        unitId: 'unit-internal-id-1',
        unitNumber: '12',
      });
      expect(result.items[0]).not.toHaveProperty('unit');
    });
  });

  describe('listPaymentsByUnit — human-readable unit identity (FIN-PAY-REVIEW-01B)', () => {
    it('scopes the where clause to the unit, joins unit in one query, and flattens unitNumber', async () => {
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p1', unitId: 'u1', unit: { unitNumber: '12' } },
        { id: 'p2', unitId: 'u1', unit: { unitNumber: '12' } },
      ]);
      prisma.payment.count.mockResolvedValue(2);

      const result = await repo.listPaymentsByUnit('u1', { skip: 0, take: 20 });

      expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { unitId: 'u1' },
          include: { unit: { select: { unitNumber: true } } },
        }),
      );
      expect(result).toEqual({
        items: [
          { id: 'p1', unitId: 'u1', unitNumber: '12' },
          { id: 'p2', unitId: 'u1', unitNumber: '12' },
        ],
        total: 2,
      });
      expect(result.items.every((item) => !('unit' in item))).toBe(true);
    });

    it('honors skip/take pagination while keeping the unitNumber flatten intact', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await repo.listPaymentsByUnit('u1', { skip: 20, take: 10 });

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 20, take: 10 }),
      );
    });
  });

  describe('createExpense — Fund-sufficiency + Ledger/Fund-balance effect (FIN-EXP-02)', () => {
    it('creates the Expense, writes a DEBIT EXPENSE LedgerEntry, and decrements Fund.balance, all inside one transaction', async () => {
      prisma.fund.findUniqueOrThrow.mockResolvedValue({ id: 'fund-1', balance: 1_000_000 });
      prisma.expense.create.mockResolvedValue({ id: 'exp-1', amount: 200_000, status: 'POSTED' });
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      const result = await repo.createExpense({
        buildingId: 'b1',
        fundId: 'fund-1',
        title: 'Elevator repair',
        category: 'MAINTENANCE',
        amount: 200_000,
        occurredAt: new Date('2026-08-01'),
        createdById: 'actor-1',
      });

      expect(prisma.expense.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          buildingId: 'b1',
          fundId: 'fund-1',
          title: 'Elevator repair',
          category: 'MAINTENANCE',
          amount: 200_000,
          createdById: 'actor-1',
        }),
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          buildingId: 'b1',
          fundId: 'fund-1',
          entryType: 'EXPENSE',
          direction: 'DEBIT',
          amount: 200_000,
          referenceType: 'Expense',
          referenceId: 'exp-1',
        }),
      });
      expect(prisma.fund.update).toHaveBeenCalledWith({
        where: { id: 'fund-1' },
        data: { balance: { decrement: 200_000 } },
      });
      expect(result).toEqual({ id: 'exp-1', amount: 200_000, status: 'POSTED' });
    });

    it('rejects when the amount exceeds the fund balance read fresh inside the transaction, writing nothing', async () => {
      prisma.fund.findUniqueOrThrow.mockResolvedValue({ id: 'fund-1', balance: 100 });

      await expect(
        repo.createExpense({
          buildingId: 'b1',
          fundId: 'fund-1',
          title: 'Too expensive',
          category: 'OTHER',
          amount: 200,
          occurredAt: new Date(),
          createdById: 'actor-1',
        }),
      ).rejects.toThrow(BusinessRuleViolationError);

      expect(prisma.expense.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });

    it('allows an amount exactly equal to the fund balance (boundary)', async () => {
      prisma.fund.findUniqueOrThrow.mockResolvedValue({ id: 'fund-1', balance: 500 });
      prisma.expense.create.mockResolvedValue({ id: 'exp-2', amount: 500, status: 'POSTED' });
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});

      await expect(
        repo.createExpense({
          buildingId: 'b1',
          fundId: 'fund-1',
          title: 'Exact balance',
          category: 'OTHER',
          amount: 500,
          occurredAt: new Date(),
          createdById: 'actor-1',
        }),
      ).resolves.toEqual(expect.objectContaining({ id: 'exp-2' }));
    });
  });

  describe('voidExpense — concurrency-safe CAS against a double void (FIN-EXP-02)', () => {
    it('voids a POSTED expense, writes a CREDIT counter-entry, and increments Fund.balance back', async () => {
      prisma.expense.updateMany.mockResolvedValue({ count: 1 });
      prisma.ledgerEntry.create.mockResolvedValue({});
      prisma.fund.update.mockResolvedValue({});
      prisma.expense.findUniqueOrThrow.mockResolvedValue({ id: 'exp-1', status: 'VOIDED' });

      const result = await repo.voidExpense({
        expenseId: 'exp-1',
        buildingId: 'b1',
        fundId: 'fund-1',
        amount: 200_000,
        voidReason: 'entered wrong amount',
        actorId: 'actor-1',
      });

      expect(prisma.expense.updateMany).toHaveBeenCalledWith({
        where: { id: 'exp-1', status: 'POSTED' },
        data: expect.objectContaining({
          status: 'VOIDED',
          voidedById: 'actor-1',
          voidReason: 'entered wrong amount',
        }),
      });
      expect(prisma.ledgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: 'EXPENSE',
          direction: 'CREDIT',
          amount: 200_000,
          referenceType: 'Expense',
          referenceId: 'exp-1',
        }),
      });
      expect(prisma.fund.update).toHaveBeenCalledWith({
        where: { id: 'fund-1' },
        data: { balance: { increment: 200_000 } },
      });
      expect(result).toEqual({ id: 'exp-1', status: 'VOIDED' });
    });

    it('throws ConflictError and writes nothing when the CAS updateMany claims zero rows (already voided / lost the race)', async () => {
      prisma.expense.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repo.voidExpense({
          expenseId: 'exp-1',
          buildingId: 'b1',
          fundId: 'fund-1',
          amount: 200_000,
          voidReason: 'dup',
          actorId: 'actor-1',
        }),
      ).rejects.toThrow(ConflictError);

      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.fund.update).not.toHaveBeenCalled();
    });
  });

  describe('listExpenses — default excludes VOIDED, filters compose (FIN-EXP-02)', () => {
    it('defaults to status POSTED when no status filter is given', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await repo.listExpenses('b1', { skip: 0, take: 20 });

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1', status: 'POSTED' } }),
      );
    });

    it('honors an explicit status filter (e.g. VOIDED) instead of the default', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await repo.listExpenses('b1', { skip: 0, take: 20 }, { status: 'VOIDED' });

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1', status: 'VOIDED' } }),
      );
    });

    it('composes fundId/category/date-range filters alongside the default status', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      const fromDate = new Date('2026-01-01');
      const toDate = new Date('2026-02-01');
      await repo.listExpenses(
        'b1',
        { skip: 0, take: 20 },
        { fundId: 'fund-1', category: 'UTILITIES', fromDate, toDate },
      );

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            buildingId: 'b1',
            fundId: 'fund-1',
            category: 'UTILITIES',
            status: 'POSTED',
            occurredAt: { gte: fromDate, lte: toDate },
          },
        }),
      );
    });

    it('orders by occurredAt desc and honors skip/take', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await repo.listExpenses('b1', { skip: 40, take: 20 });

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { occurredAt: 'desc' }, skip: 40, take: 20 }),
      );
    });
  });

  describe('getFinancialSummary — totalExpenses (FIN-EXP-02)', () => {
    it('includes totalExpenses, summing only POSTED expenses', async () => {
      prisma.fund.findMany.mockResolvedValue([]);
      prisma.chargeItem.findMany.mockResolvedValue([]);
      prisma.adjustment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.refund.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.chargeBatch.count.mockResolvedValue(0);
      prisma.expense.aggregate.mockResolvedValue({ _sum: { amount: 350_000 } });

      const summary = await repo.getFinancialSummary('b1');

      expect(prisma.expense.aggregate).toHaveBeenCalledWith({
        where: { buildingId: 'b1', status: 'POSTED' },
        _sum: { amount: true },
      });
      expect(summary.totalExpenses).toBe(350_000);
    });
  });

  describe('getFundStatement (FIN-SUM-01A)', () => {
    it('filters to the requested building + fund and to the 5 cash-moving entry types only', async () => {
      prisma.ledgerEntry.findMany.mockResolvedValue([]);
      prisma.ledgerEntry.count.mockResolvedValue(0);

      await repo.getFundStatement('b1', 'fund-1', { skip: 0, take: 20 });

      expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            buildingId: 'b1',
            fundId: 'fund-1',
            entryType: { in: ['OPENING_BALANCE', 'PAYMENT', 'EXPENSE', 'REFUND', 'REVERSAL'] },
          },
        }),
      );
      expect(prisma.ledgerEntry.count).toHaveBeenCalledWith({
        where: {
          buildingId: 'b1',
          fundId: 'fund-1',
          entryType: { in: ['OPENING_BALANCE', 'PAYMENT', 'EXPENSE', 'REFUND', 'REVERSAL'] },
        },
      });
      // CHARGE/ADJUSTMENT/CREDIT_APPLIED never appear in the `in` list above —
      // the `where` clause itself is the exclusion proof, there's no separate
      // filter step that could independently be wrong.
    });

    it('orders newest-first with a deterministic id tiebreak, and honors skip/take', async () => {
      prisma.ledgerEntry.findMany.mockResolvedValue([]);
      prisma.ledgerEntry.count.mockResolvedValue(0);

      await repo.getFundStatement('b1', 'fund-1', { skip: 40, take: 20 });

      expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 40,
          take: 20,
        }),
      );
    });

    it("batch-resolves every EXPENSE row's Expense in one findMany, deduplicated by referenceId", async () => {
      prisma.ledgerEntry.findMany.mockResolvedValue([
        { id: 'le-1', entryType: 'EXPENSE', direction: 'DEBIT', referenceId: 'exp-1' },
        { id: 'le-2', entryType: 'EXPENSE', direction: 'CREDIT', referenceId: 'exp-1' },
        { id: 'le-3', entryType: 'PAYMENT', direction: 'CREDIT', referenceId: 'pay-1' },
      ]);
      prisma.ledgerEntry.count.mockResolvedValue(3);
      prisma.expense.findMany.mockResolvedValue([
        { id: 'exp-1', title: 'Elevator repair', occurredAt: new Date('2026-01-05') },
      ]);

      const result = await repo.getFundStatement('b1', 'fund-1', { skip: 0, take: 20 });

      // le-1 and le-2 both reference exp-1 — one call, one id, not two.
      expect(prisma.expense.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.expense.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['exp-1'] } },
        select: { id: true, title: true, occurredAt: true },
      });
      expect(result.expenses).toEqual([
        { id: 'exp-1', title: 'Elevator repair', occurredAt: new Date('2026-01-05') },
      ]);
    });

    it('skips the Expense batch query entirely when the page has no EXPENSE rows', async () => {
      prisma.ledgerEntry.findMany.mockResolvedValue([
        { id: 'le-1', entryType: 'PAYMENT', direction: 'CREDIT', referenceId: 'pay-1' },
      ]);
      prisma.ledgerEntry.count.mockResolvedValue(1);

      await repo.getFundStatement('b1', 'fund-1', { skip: 0, take: 20 });

      expect(prisma.expense.findMany).not.toHaveBeenCalled();
    });

    it('returns items/total/expenses', async () => {
      const entries = [
        { id: 'le-1', entryType: 'REFUND', direction: 'DEBIT', referenceId: 'ref-1' },
      ];
      prisma.ledgerEntry.findMany.mockResolvedValue(entries);
      prisma.ledgerEntry.count.mockResolvedValue(7);

      const result = await repo.getFundStatement('b1', 'fund-1', { skip: 0, take: 20 });

      expect(result).toEqual({ items: entries, total: 7, expenses: [] });
    });
  });
});
