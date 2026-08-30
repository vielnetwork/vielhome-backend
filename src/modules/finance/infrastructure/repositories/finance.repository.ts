import { Injectable } from '@nestjs/common';
import {
  ChargeCalculationMethod,
  ChargeKind,
  ChargeItemStatus,
  ChargePayerType,
  ChargeUnitScope,
  ExpenseCategory,
  ExpenseStatus,
  FundAccountLinkType,
  FundType,
  LateFeeType,
  LedgerEntryType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { BusinessRuleViolationError, ConflictError } from '../../../../common/errors/app-error';

/**
 * Entry types whose ledger write actually moves `Fund.balance` (the
 * denormalized cash-balance cache). See the Finance section comment in
 * `schema.prisma` for the full accounting model this encodes:
 *  - PAYMENT is real cash received — it DOES update the cache.
 *  - REFUND is real cash given back to the payer — it DOES update the
 *    cache (as a decrement).
 *  - REVERSAL (added in ADR-037) undoes an erroneous PAYMENT's cash
 *    effect as if it never happened — it DOES update the cache (as a
 *    decrement, the mirror image of the PAYMENT it reverses).
 *  - CHARGE is recognition of a receivable, not cash — it does NOT.
 *  - ADJUSTMENT (implemented in ADR-037) corrects what a unit OWES, not
 *    what the fund physically HOLDS — waiving debt or adding a fee moves
 *    no actual cash — so it does NOT update the cache either. This
 *    corrects this function's own pre-ADR-037 assumption (ADJUSTMENT was
 *    listed here as a "real cash event" before any code ever created one
 *    — dead, never-exercised logic since ADR-023) now that a real
 *    Adjustment implementation exists to clarify against.
 *  - CREDIT_APPLIED reallocates cash that was already counted into the
 *    cache at the time the original overpayment's PAYMENT entry was
 *    written — writing it again here would double-count, so it does NOT.
 *  - EXPENSE (added for FIN-EXP-02 — see 21_ADRs > ADR-126) is real cash
 *    LEAVING the fund for a building operating cost — it DOES update the
 *    cache, as a decrement, the mirror image of PAYMENT. A void posts a
 *    second EXPENSE entry (CREDIT, increment) that restores the balance,
 *    the same "reversal creates counter entry" convention REVERSAL
 *    already established for a wrongly-approved Payment.
 */
function affectsFundBalance(entryType: LedgerEntryType): boolean {
  return (
    entryType === 'PAYMENT' ||
    entryType === 'REFUND' ||
    entryType === 'REVERSAL' ||
    entryType === 'EXPENSE'
  );
}

function computeItemStatus(paidAmount: number, amount: number): ChargeItemStatus {
  if (paidAmount <= 0) return 'UNPAID';
  if (paidAmount >= amount) return 'PAID';
  return 'PARTIALLY_PAID';
}

export type ExplicitObligationTarget =
  { type: 'CHARGE_ITEM'; id: string } | { type: 'ADJUSTMENT'; id: string };

export function encodeObligationId(target: ExplicitObligationTarget): string {
  return `${target.type}:${target.id}`;
}

type DebtRow = { amount: number; paidAmount: number };

function buildDebtSnapshot(
  outstandingItems: DebtRow[],
  positiveAdjustments: DebtRow[],
  creditBalance: number,
  pendingPayments: { amount: number }[],
) {
  const chargeItemDebt = outstandingItems.reduce((sum, i) => sum + (i.amount - i.paidAmount), 0);
  const adjustmentDebt = positiveAdjustments.reduce(
    (sum, a) => sum + Math.max(0, a.amount - a.paidAmount),
    0,
  );
  const totalDebt = chargeItemDebt + adjustmentDebt;
  const pendingPaymentAmount = pendingPayments.reduce((sum, p) => sum + p.amount, 0);
  return {
    chargeItemDebt,
    adjustmentDebt,
    totalDebt,
    creditBalance,
    pendingPaymentAmount,
    remainingPayable: Math.max(totalDebt - creditBalance - pendingPaymentAmount, 0),
  };
}

@Injectable()
export class FinanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The physical `finance-payment:` namespace is intentionally retained so
   * old and new instances contend on the same lock during a rolling deploy.
   * Semantically this is the common serialization lock for every mutation of
   * a unit's obligations, allocations, payment reservations, or credit.
   */
  private async acquireUnitFinanceLock(tx: Prisma.TransactionClient, unitId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'finance-payment:' + unitId}))`;
  }

  private async acquireUnitFinanceLocks(tx: Prisma.TransactionClient, unitIds: string[]) {
    const orderedUnitIds = [...new Set(unitIds)].sort();
    for (const unitId of orderedUnitIds) {
      await this.acquireUnitFinanceLock(tx, unitId);
    }
  }

  // --- Funds ---------------------------------------------------------------

  /**
   * Finance Hardening Pass (post-audit) — `page`/`limit` (08_API_Architecture
   * > Pagination, ADR-072 convention), same `{ items, total }` shape
   * `BackOfficeRepository.searchPayments` already established. Previously
   * an unbounded `findMany` — the in-building Finance module's own list
   * endpoints were the one gap the audit found in the platform's otherwise
   * complete ADR-072 pagination rollout.
   */
  async listFunds(buildingId: string, pagination: { skip: number; take: number }) {
    const where = { buildingId };
    const [items, total] = await Promise.all([
      this.prisma.fund.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.fund.count({ where }),
    ]);
    return { items, total };
  }

  findFundById(fundId: string) {
    return this.prisma.fund.findUnique({ where: { id: fundId } });
  }

  listActiveChargeOptionFunds(buildingId: string) {
    return this.prisma.fund.findMany({
      where: { buildingId, isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * ADR-094 (Sprint 29) — `initialBalance` is never written directly to
   * `Fund.balance`; when positive, this posts a real `OPENING_BALANCE`
   * LedgerEntry in the same transaction and lets the balance update follow
   * the same `affectsFundBalance`-gated path every other cash movement
   * uses, keeping the Ledger the actual source of truth.
   */
  createFund(params: {
    buildingId: string;
    name: string;
    type: FundType;
    description?: string;
    isDefault?: boolean;
    initialBalance?: number;
    accountLinkType?: FundAccountLinkType;
    accountReference?: string;
    actorId?: string;
    requestId?: string;
  }) {
    const { initialBalance, actorId, requestId, ...fundData } = params;

    return this.prisma.$transaction(async (tx) => {
      const fund = await tx.fund.create({ data: fundData });

      if (initialBalance && initialBalance > 0) {
        await tx.ledgerEntry.create({
          data: {
            buildingId: params.buildingId,
            fundId: fund.id,
            entryType: 'OPENING_BALANCE',
            direction: 'CREDIT',
            amount: initialBalance,
            referenceType: 'Fund',
            referenceId: fund.id,
            description: 'موجودی اولیه صندوق',
            actorId,
            requestId,
          },
        });

        return tx.fund.update({
          where: { id: fund.id },
          data: { balance: { increment: initialBalance } },
        });
      }

      return fund;
    });
  }

  updateFund(
    fundId: string,
    params: {
      name?: string;
      type?: FundType;
      description?: string;
      accountLinkType?: FundAccountLinkType;
      accountReference?: string;
    },
  ) {
    return this.prisma.fund.update({ where: { id: fundId }, data: params });
  }

  setFundActive(fundId: string, isActive: boolean) {
    return this.prisma.fund.update({ where: { id: fundId }, data: { isActive } });
  }

  /**
   * Every building needs at least one fund before it can charge or collect
   * anything, but nothing in the Building Setup Wizard creates one — rather
   * than couple Finance to that flow (or add a fragile cross-module event),
   * the first Finance write for a building lazily creates a default CURRENT
   * fund if none exists yet. Safe to call repeatedly: `isDefault` is looked
   * up first, never assumed.
   */
  /**
   * ADR-095 — read-only counterpart to `getOrCreateDefaultFund` below, for
   * `previewChargeBatch`. Preview must never create a Fund as a side
   * effect (it must be zero-write) — this returns null instead when no
   * default fund exists yet, letting the caller surface a
   * `willCreateDefaultFund` warning instead of actually creating one.
   */
  findDefaultFund(buildingId: string) {
    return this.prisma.fund.findFirst({ where: { buildingId, isDefault: true } });
  }

  async getOrCreateDefaultFund(buildingId: string) {
    const existing = await this.prisma.fund.findFirst({ where: { buildingId, isDefault: true } });
    if (existing) return existing;

    return this.prisma.fund.create({
      data: {
        buildingId,
        name: 'صندوق جاری',
        type: 'CURRENT',
        isDefault: true,
      },
    });
  }

  // --- Charge Batches / Charge Items ----------------------------------------

  listChargeSeries(buildingId: string) {
    return this.prisma.chargeSeries.findMany({
      where: { buildingId, isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  findChargeSeriesById(id: string) {
    return this.prisma.chargeSeries.findUnique({ where: { id } });
  }

  createChargeSeries(buildingId: string, name: string) {
    return this.prisma.chargeSeries.create({ data: { buildingId, name } });
  }

  /** Creates a DRAFT batch and its ChargeItems atomically; totalAmount is the sum of `items`. */
  createChargeBatch(params: {
    buildingId: string;
    fundId: string;
    title: string;
    description?: string;
    calculationMethod: ChargeCalculationMethod;
    kind?: ChargeKind;
    expectedFundType?: FundType;
    seriesId?: string;
    periodStart?: Date;
    periodEnd?: Date;
    dueDate?: Date;
    createdById: string;
    items: Array<{ unitId: string; amount: number }>;
    // ADR-095 (Sprint 29, Charge Generation Phase 2)
    unitScope?: ChargeUnitScope;
    payerType?: ChargePayerType;
    lateFeeType?: LateFeeType;
    lateFeeValue?: number;
    lateFeeGraceDays?: number;
  }) {
    const totalAmount = params.items.reduce((sum, i) => sum + i.amount, 0);

    return this.prisma.$transaction(async (tx) => {
      if (params.kind && params.expectedFundType) {
        // The row lock makes this the authoritative compatibility check:
        // a concurrent deactivate/retype waits until this transaction has
        // persisted the batch, while a mutation that won first makes the
        // query return no row and the stale request fail cleanly.
        const compatibleFunds = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "funds"
          WHERE "id" = ${params.fundId}
            AND "buildingId" = ${params.buildingId}
            AND "isActive" = true
            AND "type"::text = ${params.expectedFundType}
          FOR UPDATE
        `);
        if (compatibleFunds.length !== 1) {
          throw new ConflictError(
            'The selected fund changed after it was validated. Refresh charge options and try again.',
            { reason: 'STALE_CHARGE_FUND_SELECTION' },
          );
        }
      }

      const batch = await tx.chargeBatch.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          title: params.title,
          description: params.description,
          calculationMethod: params.calculationMethod,
          kind: params.kind,
          seriesId: params.seriesId,
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          dueDate: params.dueDate,
          createdById: params.createdById,
          totalAmount,
          status: 'DRAFT',
          unitScope: params.unitScope,
          payerType: params.payerType,
          lateFeeType: params.lateFeeType,
          lateFeeValue: params.lateFeeValue,
          lateFeeGraceDays: params.lateFeeGraceDays,
        },
      });

      if (params.items.length > 0) {
        await tx.chargeItem.createMany({
          data: params.items.map((i) => ({
            chargeBatchId: batch.id,
            unitId: i.unitId,
            amount: i.amount,
          })),
        });
      }

      return batch;
    });
  }

  findChargeBatchById(id: string) {
    return this.prisma.chargeBatch.findUnique({
      where: { id },
      include: {
        chargeItems: { include: { unit: { select: { id: true, unitNumber: true } } } },
        fund: true,
      },
    });
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  async listChargeBatches(buildingId: string, pagination: { skip: number; take: number }) {
    const where = { buildingId };
    const [items, total] = await Promise.all([
      this.prisma.chargeBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.chargeBatch.count({ where }),
    ]);
    return { items, total };
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  async listChargeItemsByUnit(unitId: string, pagination: { skip: number; take: number }) {
    const where = { unitId };
    const [items, total] = await Promise.all([
      this.prisma.chargeItem.findMany({
        where,
        include: {
          chargeBatch: {
            select: {
              id: true,
              title: true,
              status: true,
              dueDate: true,
              lateFeeType: true,
              lateFeeValue: true,
              lateFeeGraceDays: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.chargeItem.count({ where }),
    ]);
    return { items, total };
  }

  /** ADR-095 — used by `applyLateFee`'s building+unit ownership guard and its eligibility recheck. */
  findChargeItemById(chargeItemId: string) {
    return this.prisma.chargeItem.findUnique({
      where: { id: chargeItemId },
      include: {
        chargeBatch: {
          select: {
            id: true,
            buildingId: true,
            fundId: true,
            title: true,
            status: true,
            dueDate: true,
            lateFeeType: true,
            lateFeeValue: true,
            lateFeeGraceDays: true,
          },
        },
      },
    });
  }

  /**
   * ADR-095 — late-fee eligibility candidates for a unit's outstanding
   * ChargeItems (feeds `FinanceService.getUnitDebt`'s `eligibleLateFees`).
   * Deliberately separate from `getUnitDebt`'s own debt-total query below,
   * which stays unchanged from ADR-053.
   */
  listLateFeeEligibleCandidates(unitId: string) {
    return this.prisma.chargeItem.findMany({
      where: {
        unitId,
        status: { not: 'PAID' },
        chargeBatch: { status: { in: ['ISSUED', 'CLOSED'] } },
      },
      select: {
        id: true,
        amount: true,
        paidAmount: true,
        chargeBatch: {
          select: {
            status: true,
            dueDate: true,
            lateFeeType: true,
            lateFeeValue: true,
            lateFeeGraceDays: true,
          },
        },
      },
    });
  }

  /** ADR-095 — which of these ChargeItems already have an applied (Adjustment-backed) late fee. */
  async findAppliedLateFeeChargeItemIds(chargeItemIds: string[]): Promise<Set<string>> {
    if (chargeItemIds.length === 0) return new Set();
    const rows = await this.prisma.adjustment.findMany({
      where: { sourceType: 'LATE_FEE', sourceId: { in: chargeItemIds } },
      select: { sourceId: true },
    });
    return new Set(rows.map((r) => r.sourceId as string));
  }

  cancelChargeBatch(params: { chargeBatchId: string; buildingId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const discovered = await tx.chargeBatch.findUnique({
        where: { id: params.chargeBatchId },
        select: { chargeItems: { select: { unitId: true } } },
      });
      if (!discovered) throw new BusinessRuleViolationError('Charge batch not found.');

      await this.acquireUnitFinanceLocks(
        tx,
        discovered.chargeItems.map((item) => item.unitId),
      );

      const current = await tx.chargeBatch.findUnique({
        where: { id: params.chargeBatchId },
        include: { chargeItems: { select: { paidAmount: true } } },
      });
      if (!current || current.buildingId !== params.buildingId) {
        throw new BusinessRuleViolationError('Charge batch not found.');
      }
      if (current.status === 'CLOSED' || current.status === 'CANCELLED') {
        throw new BusinessRuleViolationError(
          `A ${current.status} charge batch cannot be cancelled again.`,
        );
      }
      if (current.chargeItems.some((item) => item.paidAmount > 0)) {
        throw new BusinessRuleViolationError(
          'This charge batch has payments already applied to it and cannot be cancelled.',
        );
      }

      const cancelledAt = new Date();
      const claimed = await tx.chargeBatch.updateMany({
        where: { id: params.chargeBatchId, status: current.status },
        data: { status: 'CANCELLED', cancelledAt },
      });
      if (claimed.count !== 1) {
        throw new ConflictError('This charge batch changed before it could be cancelled.');
      }
      return tx.chargeBatch.findUniqueOrThrow({ where: { id: params.chargeBatchId } });
    });
  }

  /**
   * Issues a DRAFT batch: flips it to ISSUED, then auto-applies each
   * charged unit's existing CreditBalance (if any) against its new
   * ChargeItem, and writes the batch-level CHARGE ledger entry that
   * records the receivable. See `affectsFundBalance` above for why neither
   * of the ledger entries written here touch `Fund.balance`.
   */
  issueChargeBatch(params: {
    chargeBatchId: string;
    buildingId: string;
    fundId: string;
    totalAmount: number;
    actorId: string;
    requestId?: string;
    // ADR-095 — pre-resolved payer snapshot (unit ownership/tenancy is
    // cross-module data FinanceRepository has no access to; FinanceService
    // resolves it via BuildingRepository BEFORE calling this method, so
    // the write still lands inside this same atomic issue transaction).
    payerResolutions?: Array<{
      chargeItemId: string;
      resolvedPayerType: ChargePayerType;
      personIds: string[];
    }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const discovered = await tx.chargeBatch.findUnique({
        where: { id: params.chargeBatchId },
        select: { chargeItems: { select: { unitId: true } } },
      });
      if (!discovered) throw new BusinessRuleViolationError('Charge batch not found.');

      await this.acquireUnitFinanceLocks(
        tx,
        discovered.chargeItems.map((item) => item.unitId),
      );

      const current = await tx.chargeBatch.findUnique({
        where: { id: params.chargeBatchId },
        include: { chargeItems: true },
      });
      if (!current || current.buildingId !== params.buildingId) {
        throw new BusinessRuleViolationError('Charge batch not found.');
      }
      if (current.status !== 'DRAFT') {
        throw new BusinessRuleViolationError('Only a DRAFT charge batch can be issued.');
      }
      if (current.totalAmount <= 0 || current.chargeItems.length === 0) {
        throw new BusinessRuleViolationError(
          'A charge batch with no charge items cannot be issued.',
        );
      }

      const issuedAt = new Date();
      const claimed = await tx.chargeBatch.updateMany({
        where: { id: params.chargeBatchId, status: 'DRAFT' },
        data: { status: 'ISSUED', issuedAt },
      });
      if (claimed.count !== 1) {
        throw new ConflictError('This charge batch changed before it could be issued.');
      }

      for (const resolution of params.payerResolutions ?? []) {
        await tx.chargeItem.update({
          where: { id: resolution.chargeItemId },
          data: { resolvedPayerType: resolution.resolvedPayerType },
        });
        if (resolution.personIds.length > 0) {
          await tx.chargeItemPayer.createMany({
            data: resolution.personIds.map((personId) => ({
              chargeItemId: resolution.chargeItemId,
              personId,
            })),
          });
        }
      }

      const items = current.chargeItems;

      for (const item of items) {
        const credit = await tx.creditBalance.findUnique({ where: { unitId: item.unitId } });
        if (!credit || credit.balance <= 0) continue;

        const outstanding = item.amount - item.paidAmount;
        if (outstanding <= 0) continue;

        const applied = Math.min(credit.balance, outstanding);
        const newPaidAmount = item.paidAmount + applied;

        await tx.chargeItem.update({
          where: { id: item.id },
          data: {
            paidAmount: newPaidAmount,
            status: computeItemStatus(newPaidAmount, item.amount),
          },
        });
        const consumed = await tx.creditBalance.updateMany({
          where: { unitId: item.unitId, balance: { gte: applied } },
          data: { balance: { decrement: applied } },
        });
        if (consumed.count !== 1) {
          throw new ConflictError('The unit credit balance changed before it could be applied.');
        }
        await tx.ledgerEntry.create({
          data: {
            buildingId: params.buildingId,
            fundId: current.fundId,
            entryType: 'CREDIT_APPLIED',
            direction: 'CREDIT',
            amount: applied,
            referenceType: 'ChargeItem',
            referenceId: item.id,
            actorId: params.actorId,
            requestId: params.requestId,
            description: 'Existing credit balance auto-applied at charge issue.',
          },
        });
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: current.fundId,
          entryType: 'CHARGE',
          direction: 'DEBIT',
          amount: current.totalAmount,
          referenceType: 'ChargeBatch',
          referenceId: params.chargeBatchId,
          actorId: params.actorId,
          requestId: params.requestId,
        },
      });

      return tx.chargeBatch.findUniqueOrThrow({ where: { id: params.chargeBatchId } });
    });
  }

  // --- Payments --------------------------------------------------------------

  /**
   * Finance QA correction — physical-device duplicate-payment bug (2026-08).
   * Root cause: `createPayment` used to be a bare, unvalidated
   * `payment.create` — nothing stopped the same confirmed debt from being
   * reported as a fresh PENDING_APPROVAL payment any number of times,
   * since a still-pending payment (correctly — see `PaymentPolicy`'s own
   * doc comment on why PENDING_APPROVAL never touches the ledger) never
   * reduced `getUnitDebt`'s `totalDebt`, and Mobile's auto-fill kept
   * re-offering the same full debt on every screen visit.
   *
   * This method now re-validates the requested amount against the unit's
   * current *remaining payable* — `computeDebtSnapshot`'s own doc comment
   * has the full confirmed-debt / pending-payment / remaining-payable
   * model — inside a single transaction, serialized per-unit via a
   * Postgres advisory transaction lock (`pg_advisory_xact_lock`, the same
   * pattern `BackofficeRepository.changePersonSuspensionAtomically`
   * already established for "read-then-validate-then-write must be
   * atomic across concurrent callers" — released automatically at
   * transaction end, no manual unlock/deadlock risk). Two near-
   * simultaneous submissions for the same unit can therefore never both
   * read the same stale remaining-payable figure and both pass
   * validation: the second blocks until the first's transaction commits
   * (or rolls back), then re-computes against the now-current
   * PENDING_APPROVAL total.
   *
   * `isManualAmount` (mirrors Mobile's "I'll enter the amount myself"
   * checkbox and the zero-debt/credit confirmation's "Yes" — see
   * `CreatePaymentDto`'s own doc comment) is the explicit contract that
   * bypasses the remaining-payable ceiling. A manually-entered amount may
   * legitimately exceed it — a partial payment, a deliberate overpayment
   * that becomes `CreditBalance` (already how `approvePayment` has always
   * handled overpayment), or a voluntary payment reported while remaining
   * payable is already zero. An auto-filled (non-manual) submission must
   * never exceed it — that gap is exactly what let repeated taps create
   * duplicate PENDING_APPROVAL payments for the same debt. Intent is never
   * inferred from the amount itself; it is always this explicit flag.
   *
   * FIN-MVP-GAP-04C — `idempotencyKey` is now required (`CreatePaymentDto`'s
   * own doc comment) and given the exact same replay-safety
   * `createExplicitPayment` below already established: checked, under the
   * SAME per-unit advisory lock, against the existing
   * `@@unique([payerId, buildingId, idempotencyKey])` constraint. The
   * conflict comparison below covers the canonical persisted payment
   * request/content — `unitId`, the resolved `fundId`, `amount`, `method`,
   * `reference`, `note` — so an identical replay (same payerId/buildingId/
   * idempotencyKey AND the same values for all of those) returns the
   * existing Payment unchanged; the same key reused with a materially
   * different value for any of them throws `ConflictError`. `isManualAmount`
   * is a request-time remaining-payable validation override, not persisted
   * Payment identity (there is no `Payment.isManualAmount` column — see
   * `CreatePaymentDto`'s own doc comment), and therefore is not part of
   * this replay payload comparison. The lookup happens BEFORE the
   * remaining-payable check for the same reason `createExplicitPayment`
   * checks it first: a blocked concurrent retry must resolve to the
   * winner's already-committed row without ever re-evaluating (and
   * potentially failing) the ceiling a second time.
   */
  createPayment(params: {
    buildingId: string;
    unitId: string;
    fundId: string;
    payerId: string;
    amount: number;
    method: PaymentMethod;
    idempotencyKey: string;
    reference?: string;
    note?: string;
    isManualAmount: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireUnitFinanceLock(tx, params.unitId);

      const existing = await tx.payment.findFirst({
        where: {
          payerId: params.payerId,
          buildingId: params.buildingId,
          idempotencyKey: params.idempotencyKey,
        },
      });
      if (existing) {
        const same =
          existing.unitId === params.unitId &&
          existing.fundId === params.fundId &&
          existing.amount === params.amount &&
          existing.method === params.method &&
          (existing.reference ?? null) === (params.reference ?? null) &&
          (existing.note ?? null) === (params.note ?? null);
        if (!same) {
          throw new ConflictError(
            'Idempotency key was already used with a different payment request.',
          );
        }
        return existing;
      }

      if (!params.isManualAmount) {
        const snapshot = await this.computeDebtSnapshot(tx, params.unitId);
        if (params.amount > snapshot.remainingPayable) {
          throw new BusinessRuleViolationError(
            `This amount exceeds the unit's remaining payable amount (${snapshot.remainingPayable}). ` +
              'If you intend to report a different amount, enable manual entry.',
          );
        }
      }

      return tx.payment.create({
        data: {
          buildingId: params.buildingId,
          unitId: params.unitId,
          fundId: params.fundId,
          payerId: params.payerId,
          amount: params.amount,
          method: params.method,
          reference: params.reference,
          note: params.note,
          idempotencyKey: params.idempotencyKey,
          status: 'PENDING_APPROVAL',
        },
      });
    });
  }

  async listSelectableObligations(unitId: string) {
    const [items, adjustments] = await Promise.all([
      this.prisma.chargeItem.findMany({
        where: {
          unitId,
          status: { not: 'PAID' },
          chargeBatch: { status: { in: ['ISSUED', 'CLOSED'] } },
        },
        include: {
          chargeBatch: {
            select: {
              title: true,
              description: true,
              kind: true,
              seriesId: true,
              periodStart: true,
              fund: { select: { id: true, name: true, type: true } },
            },
          },
          debtSelections: {
            where: { reservationState: 'ACTIVE' },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: [{ chargeBatch: { periodStart: 'asc' } }, { createdAt: 'asc' }],
      }),
      this.prisma.adjustment.findMany({
        where: { unitId, amount: { gt: 0 } },
        include: {
          fund: { select: { id: true, name: true, type: true } },
          debtSelections: {
            where: { reservationState: 'ACTIVE' },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const monthlyPredecessor = new Map<string, string>();
    const monthlyLatestOutstanding = new Map<string, string>();
    for (const item of items) {
      const remaining = item.amount - item.paidAmount;
      const seriesId = item.chargeBatch.seriesId;
      if (remaining > 0 && item.chargeBatch.kind === ChargeKind.MONTHLY && seriesId) {
        const predecessorId = monthlyLatestOutstanding.get(seriesId);
        if (predecessorId) monthlyPredecessor.set(item.id, predecessorId);
        monthlyLatestOutstanding.set(seriesId, item.id);
      }
    }

    return [
      ...items
        .map((item) => {
          const remainingPayable = item.amount - item.paidAmount;
          const reserved = item.debtSelections.length > 0;
          const predecessorId = monthlyPredecessor.get(item.id);
          const monthlyBlocked = predecessorId !== undefined;
          const reason = reserved
            ? 'PENDING_RESERVATION'
            : monthlyBlocked
              ? 'OLDER_MONTHLY_OBLIGATION_REQUIRED'
              : null;
          return {
            obligationId: encodeObligationId({ type: 'CHARGE_ITEM', id: item.id }),
            type: 'CHARGE_ITEM' as const,
            title: item.chargeBatch.title,
            description: item.chargeBatch.description,
            originalAmount: item.amount,
            remainingPayable,
            fund: item.chargeBatch.fund,
            chargeKind: item.chargeBatch.kind,
            seriesId: item.chargeBatch.seriesId,
            periodStart: item.chargeBatch.periodStart,
            selectable: reason === null,
            unselectableReason: reason,
            blockedByObligationId:
              monthlyBlocked && !reserved
                ? encodeObligationId({ type: 'CHARGE_ITEM', id: predecessorId! })
                : null,
          };
        })
        .filter((item) => item.remainingPayable > 0),
      ...adjustments
        .map((adjustment) => {
          const remainingPayable = adjustment.amount - adjustment.paidAmount;
          const reserved = adjustment.debtSelections.length > 0;
          return {
            obligationId: encodeObligationId({ type: 'ADJUSTMENT', id: adjustment.id }),
            type: 'ADJUSTMENT' as const,
            title: adjustment.reason,
            description: null,
            originalAmount: adjustment.amount,
            remainingPayable,
            fund: adjustment.fund,
            chargeKind: null,
            seriesId: null,
            periodStart: null,
            selectable: !reserved,
            unselectableReason: reserved ? 'PENDING_RESERVATION' : null,
            blockedByObligationId: null,
          };
        })
        .filter((item) => item.remainingPayable > 0),
    ];
  }

  createExplicitPayment(params: {
    buildingId: string;
    unitId: string;
    payerId: string;
    method: PaymentMethod;
    idempotencyKey: string;
    reference?: string;
    note?: string;
    targets: ExplicitObligationTarget[];
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireUnitFinanceLock(tx, params.unitId);

      const existing = await tx.payment.findFirst({
        where: {
          payerId: params.payerId,
          buildingId: params.buildingId,
          idempotencyKey: params.idempotencyKey,
        },
        include: { debtSelections: true },
      });
      if (existing) {
        const existingTargets = existing.debtSelections
          .map((row) =>
            row.chargeItemId
              ? encodeObligationId({ type: 'CHARGE_ITEM', id: row.chargeItemId })
              : encodeObligationId({ type: 'ADJUSTMENT', id: row.adjustmentId! }),
          )
          .sort();
        const requestedTargets = params.targets.map(encodeObligationId).sort();
        const same =
          existing.selectionMode === 'EXPLICIT_SELECTION' &&
          existing.unitId === params.unitId &&
          existing.method === params.method &&
          (existing.reference ?? null) === (params.reference ?? null) &&
          (existing.note ?? null) === (params.note ?? null) &&
          JSON.stringify(existingTargets) === JSON.stringify(requestedTargets);
        if (!same)
          throw new ConflictError(
            'Idempotency key was already used with a different payment request.',
          );
        return existing;
      }

      const chargeIds = params.targets.filter((t) => t.type === 'CHARGE_ITEM').map((t) => t.id);
      const adjustmentIds = params.targets.filter((t) => t.type === 'ADJUSTMENT').map((t) => t.id);
      const [items, adjustments] = await Promise.all([
        tx.chargeItem.findMany({
          where: { id: { in: chargeIds } },
          include: {
            chargeBatch: true,
            debtSelections: { where: { reservationState: 'ACTIVE' }, select: { id: true } },
          },
        }),
        tx.adjustment.findMany({
          where: { id: { in: adjustmentIds } },
          include: {
            debtSelections: { where: { reservationState: 'ACTIVE' }, select: { id: true } },
          },
        }),
      ]);

      if (items.length !== chargeIds.length || adjustments.length !== adjustmentIds.length) {
        throw new BusinessRuleViolationError('One or more selected obligations do not exist.');
      }
      if (
        items.some(
          (item) =>
            item.unitId !== params.unitId ||
            item.chargeBatch.buildingId !== params.buildingId ||
            !['ISSUED', 'CLOSED'].includes(item.chargeBatch.status),
        ) ||
        adjustments.some(
          (adjustment) =>
            adjustment.unitId !== params.unitId || adjustment.buildingId !== params.buildingId,
        )
      ) {
        throw new BusinessRuleViolationError(
          'Every obligation must belong to the exact payment unit.',
        );
      }
      if (
        items.some(
          (item) => item.amount - item.paidAmount <= 0 || item.debtSelections.length > 0,
        ) ||
        adjustments.some(
          (adjustment) =>
            adjustment.amount - adjustment.paidAmount <= 0 || adjustment.debtSelections.length > 0,
        )
      ) {
        throw new ConflictError('One or more obligations are no longer selectable.');
      }

      const selectedItemIds = new Set(items.map((item) => item.id));
      const selectedMonthlySeries = new Set(
        items
          .filter((item) => item.chargeBatch.kind === 'MONTHLY' && item.chargeBatch.seriesId)
          .map((item) => item.chargeBatch.seriesId!),
      );
      for (const seriesId of selectedMonthlySeries) {
        const outstanding = await tx.chargeItem.findMany({
          where: {
            unitId: params.unitId,
            status: { not: 'PAID' },
            chargeBatch: { seriesId, kind: 'MONTHLY', status: { in: ['ISSUED', 'CLOSED'] } },
          },
          include: { chargeBatch: { select: { periodStart: true } } },
          orderBy: { chargeBatch: { periodStart: 'asc' } },
        });
        const selectedCount = outstanding.filter((item) => selectedItemIds.has(item.id)).length;
        if (outstanding.slice(0, selectedCount).some((item) => !selectedItemIds.has(item.id))) {
          throw new BusinessRuleViolationError(
            'Monthly obligations must be selected oldest first without gaps.',
          );
        }
      }

      const fundIds = new Set([
        ...items.map((item) => item.chargeBatch.fundId),
        ...adjustments.map((adjustment) => adjustment.fundId),
      ]);
      if (fundIds.size !== 1) {
        throw new BusinessRuleViolationError(
          'All selected obligations must belong to the same fund.',
        );
      }
      const fund = await tx.fund.findUnique({ where: { id: [...fundIds][0] } });
      if (!fund?.isActive) {
        throw new BusinessRuleViolationError(
          'The selected obligations belong to an inactive fund.',
        );
      }

      const amount =
        items.reduce((sum, item) => sum + item.amount - item.paidAmount, 0) +
        adjustments.reduce((sum, adjustment) => sum + adjustment.amount - adjustment.paidAmount, 0);
      const payment = await tx.payment.create({
        data: {
          buildingId: params.buildingId,
          unitId: params.unitId,
          fundId: [...fundIds][0],
          payerId: params.payerId,
          amount,
          method: params.method,
          reference: params.reference,
          note: params.note,
          idempotencyKey: params.idempotencyKey,
          selectionMode: 'EXPLICIT_SELECTION',
          debtSelections: {
            create: [
              ...items.map((item) => ({
                chargeItemId: item.id,
                selectedAmount: item.amount - item.paidAmount,
                reservationState: 'ACTIVE' as const,
              })),
              ...adjustments.map((adjustment) => ({
                adjustmentId: adjustment.id,
                selectedAmount: adjustment.amount - adjustment.paidAmount,
                reservationState: 'ACTIVE' as const,
              })),
            ],
          },
        },
        include: { debtSelections: true },
      });
      return payment;
    });
  }

  findPaymentById(id: string) {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  /**
   * FIN-REC-01B — batched lookup backing `FinanceService.attachReceiptMetadata`'s
   * `hasReceipt`/`receipt` list-response enrichment. Reads
   * `document_references`/`document_versions` directly through the shared
   * Prisma client rather than going through `DocumentRepository`/
   * `DocumentsService` — no new dependency on `DocumentsModule` is needed
   * for a plain read, and it avoids the reverse-direction module import
   * that would risk a cycle with `DocumentsModule` (which already imports
   * `FinanceModule` for `FinanceService`, see that module's own comment).
   * `Payment` has no typed Prisma relation to `DocumentReference` (its
   * `entityId` is a deliberately untyped string — see that model's own
   * schema comment), so this is a manual `entityId IN (...)` filter, not a
   * relation `include`. At most one PAYMENT-typed reference exists per
   * `entityId` (the partial unique index `document_references_payment_entityId_key`
   * guarantees it — see the FIN-REC-00A foundation migration), so no
   * de-duplication is needed on the result.
   */
  async listPaymentReceiptsByPaymentIds(paymentIds: string[]) {
    if (paymentIds.length === 0) return [];
    return this.prisma.documentReference.findMany({
      where: { entityType: 'PAYMENT', entityId: { in: paymentIds } },
      include: { documentVersion: true },
    });
  }

  /**
   * FIN-PAY-REVIEW-01B — flattens the `unit: {unitNumber}` relation
   * `listPayments`/`listPaymentsByUnit` now `include` into a single
   * `unitNumber` field on the returned row, and drops the nested `unit`
   * object entirely so it never reaches a serialized response (the
   * caller only ever gets `unitId`, unchanged, plus this new
   * `unitNumber`). `Payment.unit` is a required relation
   * (`Payment.unitId String` / `unit Unit @relation(...)`, both
   * non-nullable — see `schema.prisma`) and `Unit.unitNumber` is itself
   * a required, unique-per-building `String` — so `unit` is guaranteed
   * present on every row Prisma returns here and `unitNumber` is always
   * a plain `string`, never `null`.
   */
  private flattenUnitNumber<T extends { unit: { unitNumber: string } }>(
    payment: T,
  ): Omit<T, 'unit'> & { unitNumber: string } {
    const { unit, ...rest } = payment;
    return { ...rest, unitNumber: unit.unitNumber };
  }

  /**
   * Finance Hardening Pass — paginated, see `listFunds`'s own doc comment.
   * Backend ↔ Mobile Contract Alignment — optional `status` filter, backed
   * by the pre-existing `@@index([buildingId, status])` on `Payment`
   * (added independently of this change, confirmed by direct schema read —
   * no new index or migration needed for this filter to be cheap).
   * FIN-PAY-REVIEW-01B — `unit` is joined via `include` on this SAME
   * `findMany` call (one query, a single SQL JOIN — no second round trip,
   * no N+1), then flattened to `unitNumber` by `flattenUnitNumber` before
   * the raw Prisma row is returned. Mirrors the `unit: {select:{...}}`
   * join precedent already used by `findChargeBatchById` (this file) and
   * `BuildingRepository`'s membership listing, narrowed to just
   * `unitNumber` (the only field this contract needs).
   */
  async listPayments(
    buildingId: string,
    pagination: { skip: number; take: number },
    status?: PaymentStatus,
  ) {
    const where = { buildingId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        include: { unit: { select: { unitNumber: true } } },
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items: items.map((item) => this.flattenUnitNumber(item)), total };
  }

  /**
   * Finance Hardening Pass — paginated, see `listFunds`'s own doc comment.
   * FIN-PAY-REVIEW-01B — same single-query `unit` include +
   * `flattenUnitNumber` as `listPayments` above.
   */
  async listPaymentsByUnit(unitId: string, pagination: { skip: number; take: number }) {
    const where = { unitId };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        include: { unit: { select: { unitNumber: true } } },
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items: items.map((item) => this.flattenUnitNumber(item)), total };
  }

  rejectPayment(id: string, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.payment.findUnique({ where: { id } });
      if (!candidate) throw new BusinessRuleViolationError('Payment not found.');
      await this.acquireUnitFinanceLock(tx, candidate.unitId);
      const current = await tx.payment.findUnique({ where: { id } });
      if (!current || current.status !== 'PENDING_APPROVAL') {
        throw new BusinessRuleViolationError('Only a pending payment can be rejected.');
      }
      const payment = await tx.payment.update({
        where: { id },
        data: { status: 'REJECTED', rejectedReason: reason },
      });
      if (payment.selectionMode === 'EXPLICIT_SELECTION') {
        await tx.paymentDebtSelection.updateMany({
          where: { paymentId: id, reservationState: 'ACTIVE' },
          data: { reservationState: 'RELEASED' },
        });
      }
      return payment;
    });
  }

  /**
   * Approves a payment: allocates it oldest-debt-first across the unit's
   * outstanding ChargeItems, THEN (21_ADRs > ADR-053) any remainder against
   * the unit's outstanding positive (debt-adding) Adjustments — oldest
   * `createdAt` first, since an Adjustment has no `dueDate` to sort by —
   * banks whatever's left after both as CreditBalance, writes the single
   * cash-moving PAYMENT ledger entry for the full amount, and bumps
   * `Fund.balance`. All in one transaction — a payment is never left
   * "approved" without its allocation, or vice versa. ChargeItems are
   * always exhausted before any Adjustment is touched — a disclosed
   * ordering choice (not a source-specified rule), consistent with
   * `Adjustment`'s existing "corrects what's owed, not a substitute for a
   * real charge" role in this schema.
   */
  approvePayment(params: {
    paymentId: string;
    buildingId: string;
    unitId: string;
    fundId: string;
    amount: number;
    actorId: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireUnitFinanceLock(tx, params.unitId);
      const current = await tx.payment.findUnique({
        where: { id: params.paymentId },
        include: { debtSelections: true },
      });
      if (!current || current.status !== 'PENDING_APPROVAL') {
        throw new BusinessRuleViolationError('Only a pending payment can be approved.');
      }

      if (current.selectionMode === 'EXPLICIT_SELECTION') {
        if (
          current.debtSelections.length === 0 ||
          current.debtSelections.some((selection) => selection.reservationState !== 'ACTIVE')
        ) {
          throw new ConflictError('Explicit payment reservations are no longer active.');
        }
        const selectedTotal = current.debtSelections.reduce(
          (sum, selection) => sum + selection.selectedAmount,
          0,
        );
        if (selectedTotal !== current.amount || current.amount !== params.amount) {
          throw new BusinessRuleViolationError(
            'Explicit selection total must equal Payment.amount.',
          );
        }

        for (const selection of current.debtSelections) {
          if (selection.chargeItemId) {
            const item = await tx.chargeItem.findUniqueOrThrow({
              where: { id: selection.chargeItemId },
              include: { chargeBatch: { select: { status: true } } },
            });
            const outstanding = item.amount - item.paidAmount;
            if (
              outstanding !== selection.selectedAmount ||
              item.unitId !== params.unitId ||
              !['ISSUED', 'CLOSED'].includes(item.chargeBatch.status)
            ) {
              throw new ConflictError('Selected ChargeItem changed before approval.');
            }
            const newPaidAmount = item.paidAmount + selection.selectedAmount;
            await tx.paymentAllocation.create({
              data: {
                paymentId: params.paymentId,
                chargeItemId: item.id,
                amount: selection.selectedAmount,
              },
            });
            await tx.chargeItem.update({
              where: { id: item.id },
              data: {
                paidAmount: newPaidAmount,
                status: computeItemStatus(newPaidAmount, item.amount),
              },
            });
          } else {
            const adjustment = await tx.adjustment.findUniqueOrThrow({
              where: { id: selection.adjustmentId! },
            });
            const outstanding = adjustment.amount - adjustment.paidAmount;
            if (outstanding !== selection.selectedAmount || adjustment.unitId !== params.unitId) {
              throw new ConflictError('Selected Adjustment changed before approval.');
            }
            await tx.paymentAllocation.create({
              data: {
                paymentId: params.paymentId,
                adjustmentId: adjustment.id,
                amount: selection.selectedAmount,
              },
            });
            await tx.adjustment.update({
              where: { id: adjustment.id },
              data: { paidAmount: { increment: selection.selectedAmount } },
            });
          }
        }

        await tx.paymentDebtSelection.updateMany({
          where: { paymentId: params.paymentId, reservationState: 'ACTIVE' },
          data: { reservationState: 'APPLIED' },
        });
        const payment = await tx.payment.update({
          where: { id: params.paymentId },
          data: { status: 'APPROVED', approvedById: params.actorId, approvedAt: new Date() },
        });
        await tx.ledgerEntry.create({
          data: {
            buildingId: params.buildingId,
            fundId: params.fundId,
            entryType: 'PAYMENT',
            direction: 'CREDIT',
            amount: params.amount,
            referenceType: 'Payment',
            referenceId: params.paymentId,
            actorId: params.actorId,
            requestId: params.requestId,
          },
        });
        await tx.fund.update({
          where: { id: params.fundId },
          data: { balance: { increment: params.amount } },
        });
        return payment;
      }

      const payment = await tx.payment.update({
        where: { id: params.paymentId },
        data: { status: 'APPROVED', approvedById: params.actorId, approvedAt: new Date() },
      });

      // Oldest-debt-first: earliest due date, then earliest created. Nested
      // relation ordering on `chargeBatch.dueDate` — a DRAFT/never-issued
      // batch has no items yet so this only ever sees ISSUED batches.
      const outstandingItems = await tx.chargeItem.findMany({
        where: {
          unitId: params.unitId,
          status: { not: 'PAID' },
          chargeBatch: { status: { in: ['ISSUED', 'CLOSED'] } },
        },
        include: { chargeBatch: { select: { dueDate: true } } },
        orderBy: [{ chargeBatch: { dueDate: 'asc' } }, { createdAt: 'asc' }],
      });

      let remaining = params.amount;
      for (const item of outstandingItems) {
        if (remaining <= 0) break;
        const outstanding = item.amount - item.paidAmount;
        if (outstanding <= 0) continue;

        const applied = Math.min(remaining, outstanding);
        const newPaidAmount = item.paidAmount + applied;

        await tx.paymentAllocation.create({
          data: { paymentId: params.paymentId, chargeItemId: item.id, amount: applied },
        });
        await tx.chargeItem.update({
          where: { id: item.id },
          data: {
            paidAmount: newPaidAmount,
            status: computeItemStatus(newPaidAmount, item.amount),
          },
        });

        remaining -= applied;
      }

      // 21_ADRs > ADR-053 — once every outstanding ChargeItem is settled,
      // apply whatever's left against the unit's outstanding positive
      // Adjustments, oldest-created first.
      if (remaining > 0) {
        const outstandingAdjustments = await tx.adjustment.findMany({
          where: { unitId: params.unitId, amount: { gt: 0 } },
          orderBy: { createdAt: 'asc' },
        });

        for (const adjustment of outstandingAdjustments) {
          if (remaining <= 0) break;
          const outstanding = adjustment.amount - adjustment.paidAmount;
          if (outstanding <= 0) continue;

          const applied = Math.min(remaining, outstanding);
          const newPaidAmount = adjustment.paidAmount + applied;

          await tx.paymentAllocation.create({
            data: { paymentId: params.paymentId, adjustmentId: adjustment.id, amount: applied },
          });
          await tx.adjustment.update({
            where: { id: adjustment.id },
            data: { paidAmount: newPaidAmount },
          });

          remaining -= applied;
        }
      }

      if (remaining > 0) {
        await tx.creditBalance.upsert({
          where: { unitId: params.unitId },
          create: { unitId: params.unitId, buildingId: params.buildingId, balance: remaining },
          update: { balance: { increment: remaining } },
        });
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'PAYMENT',
          direction: 'CREDIT',
          amount: params.amount,
          referenceType: 'Payment',
          referenceId: params.paymentId,
          actorId: params.actorId,
          requestId: params.requestId,
        },
      });

      if (affectsFundBalance('PAYMENT')) {
        await tx.fund.update({
          where: { id: params.fundId },
          data: { balance: { increment: params.amount } },
        });
      }

      return payment;
    });
  }

  // --- Adjustments (08.05 Rule 014 — see 21_ADRs > ADR-037) -------------------

  /**
   * Creates an `Adjustment` and applies its debt effect in one transaction.
   * A negative `amount` (waiver) is applied oldest-debt-first across the
   * unit's outstanding `ChargeItem`s — the exact same allocation loop as
   * `approvePayment` above, just incrementing `paidAmount` directly with
   * no per-item breakdown row (unlike Payment, Adjustment has no
   * allocation-join-table concept in its source model). A positive
   * `amount` (added debt, e.g. a late fee) touches no `ChargeItem` at all
   * — see this file's own `getUnitDebt` and the model's schema comment for
   * why. Neither case touches `Fund.balance` — see `affectsFundBalance`.
   */
  createAdjustment(params: {
    unitId: string;
    buildingId: string;
    fundId: string;
    amount: number;
    reason: string;
    createdById: string;
    requestId?: string;
    // ADR-095 — set only for system-originated adjustments (e.g. an
    // applied late fee); left undefined for every ordinary manual
    // adjustment, unchanged since ADR-037. See Adjustment's own schema
    // comment for why NULL/NULL never collides with the DB-level
    // `@@unique([sourceType, sourceId])` constraint.
    sourceType?: string;
    sourceId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireUnitFinanceLock(tx, params.unitId);

      if (params.sourceType === 'LATE_FEE' && params.sourceId) {
        const sourceItem = await tx.chargeItem.findUnique({
          where: { id: params.sourceId },
          include: { chargeBatch: { select: { status: true } } },
        });
        if (
          !sourceItem ||
          sourceItem.unitId !== params.unitId ||
          !['ISSUED', 'CLOSED'].includes(sourceItem.chargeBatch.status)
        ) {
          throw new BusinessRuleViolationError(
            'A late fee can only be applied to an active issued obligation.',
          );
        }
      }

      const adjustment = await tx.adjustment.create({
        data: {
          unitId: params.unitId,
          buildingId: params.buildingId,
          fundId: params.fundId,
          amount: params.amount,
          reason: params.reason,
          createdById: params.createdById,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
        },
      });

      if (params.amount < 0) {
        let remaining = Math.abs(params.amount);
        const outstandingItems = await tx.chargeItem.findMany({
          where: {
            unitId: params.unitId,
            status: { not: 'PAID' },
            chargeBatch: { status: { in: ['ISSUED', 'CLOSED'] } },
          },
          include: { chargeBatch: { select: { dueDate: true } } },
          orderBy: [{ chargeBatch: { dueDate: 'asc' } }, { createdAt: 'asc' }],
        });

        for (const item of outstandingItems) {
          if (remaining <= 0) break;
          const outstanding = item.amount - item.paidAmount;
          if (outstanding <= 0) continue;

          const applied = Math.min(remaining, outstanding);
          const newPaidAmount = item.paidAmount + applied;

          await tx.chargeItem.update({
            where: { id: item.id },
            data: {
              paidAmount: newPaidAmount,
              status: computeItemStatus(newPaidAmount, item.amount),
            },
          });

          remaining -= applied;
        }
        // A waiver beyond total outstanding debt is simply not applied any
        // further — unlike overpayment, a waiver never creates spendable
        // CreditBalance (waiving debt isn't the same as receiving cash).
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'ADJUSTMENT',
          direction: params.amount < 0 ? 'CREDIT' : 'DEBIT',
          amount: Math.abs(params.amount),
          referenceType: 'Adjustment',
          referenceId: adjustment.id,
          actorId: params.createdById,
          requestId: params.requestId,
        },
      });

      return adjustment;
    });
  }

  /**
   * Finance Correction Pass — creates the Adjustment record for one Opening
   * Balance Correction AND applies its real debt/credit effect, kept
   * intentionally separate from `createAdjustment` above because that
   * method's negative-amount (waiver) path only targets outstanding
   * `ChargeItem`s and — by design (see its own doc comment) — discards any
   * waiver amount beyond what those cover rather than ever creating
   * `CreditBalance`. Both of those choices are correct for an ordinary
   * manual debt waiver, but wrong here:
   *
   *  - An opening-balance correction must never waive a unit's regular
   *    monthly `ChargeItem` charges — "effective opening balance" is
   *    deliberately kept isolated from that debt (see
   *    `FinanceService.correctOpeningBalance`'s own doc comment), so a
   *    downward correction instead waives the unit's own prior
   *    `OPENING_BALANCE_CORRECTION`-tagged positive Adjustments, oldest
   *    first — the exact debt this feature itself created.
   *  - `targetBalance` is explicitly allowed to go negative to represent a
   *    unit credit (08_API_Architecture — Charge Payment Amount UX 4B's own
   *    "credit balance" case), so any correction amount beyond what those
   *    prior corrections still owe must land in `CreditBalance`, mirroring
   *    `approvePayment`'s own "excess payment becomes spendable credit"
   *    waterfall (oldest-first debt reduction, then credit) rather than
   *    `createAdjustment`'s "excess is simply discarded" rule.
   *
   * A positive `amount` (correcting the balance up) needs none of this — it
   * just adds outstanding debt via a plain new Adjustment, identical in
   * effect to `createAdjustment`'s own positive-amount path.
   */
  applyOpeningBalanceCorrection(params: {
    unitId: string;
    buildingId: string;
    fundId: string;
    targetBalance: number;
    reason: string;
    createdById: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireUnitFinanceLock(tx, params.unitId);

      const existingCorrections = await tx.adjustment.findMany({
        where: { unitId: params.unitId, sourceType: 'OPENING_BALANCE_CORRECTION' },
        select: { amount: true },
      });
      const previousBalance = existingCorrections.reduce((sum, row) => sum + row.amount, 0);
      const delta = params.targetBalance - previousBalance;
      if (delta === 0) {
        throw new BusinessRuleViolationError(
          "The requested opening balance matches the unit's current effective opening balance; no correction is needed.",
        );
      }

      const adjustment = await tx.adjustment.create({
        data: {
          unitId: params.unitId,
          buildingId: params.buildingId,
          fundId: params.fundId,
          amount: delta,
          reason: params.reason,
          createdById: params.createdById,
          sourceType: 'OPENING_BALANCE_CORRECTION',
        },
      });

      if (delta < 0) {
        let remaining = Math.abs(delta);

        const priorCorrections = await tx.adjustment.findMany({
          where: {
            unitId: params.unitId,
            sourceType: 'OPENING_BALANCE_CORRECTION',
            amount: { gt: 0 },
            id: { not: adjustment.id },
          },
          orderBy: { createdAt: 'asc' },
        });

        for (const prior of priorCorrections) {
          if (remaining <= 0) break;
          const outstanding = prior.amount - prior.paidAmount;
          if (outstanding <= 0) continue;

          const applied = Math.min(remaining, outstanding);
          await tx.adjustment.update({
            where: { id: prior.id },
            data: { paidAmount: prior.paidAmount + applied },
          });

          remaining -= applied;
        }

        if (remaining > 0) {
          await tx.creditBalance.upsert({
            where: { unitId: params.unitId },
            create: { unitId: params.unitId, buildingId: params.buildingId, balance: remaining },
            update: { balance: { increment: remaining } },
          });
        }
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'ADJUSTMENT',
          direction: delta < 0 ? 'CREDIT' : 'DEBIT',
          amount: Math.abs(delta),
          referenceType: 'Adjustment',
          referenceId: adjustment.id,
          actorId: params.createdById,
          requestId: params.requestId,
        },
      });

      return {
        adjustment,
        previousBalance,
        newBalance: params.targetBalance,
        delta,
      };
    });
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  async listAdjustmentsByUnit(unitId: string, pagination: { skip: number; take: number }) {
    const where = { unitId };
    const [items, total] = await Promise.all([
      this.prisma.adjustment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.adjustment.count({ where }),
    ]);
    return { items, total };
  }

  /** ADR-095 — idempotency pre-check before `createAdjustment` for a system-sourced adjustment (e.g. a late fee). */
  findAdjustmentBySource(sourceType: string, sourceId: string) {
    return this.prisma.adjustment.findFirst({ where: { sourceType, sourceId } });
  }

  /**
   * A unit's total outstanding debt (08.05 "Get Property Debt") PLUS —
   * Finance QA correction (physical-device duplicate-payment bug, 2026-08)
   * — the amount still safely reportable given payments already awaiting
   * approval. `chargeItemDebt`/`adjustmentDebt`/`totalDebt`/`creditBalance`
   * are exactly the pre-existing "confirmed/accounting debt" figures,
   * computed identically to before this pass (every outstanding
   * `ChargeItem`'s remaining balance, plus the still-unpaid portion of
   * every positive (debt-adding) `Adjustment` — negative/waiving
   * Adjustments are NOT summed separately, since they already reduced the
   * relevant `ChargeItem.paidAmount` at creation time, see
   * `createAdjustment`). A PENDING_APPROVAL `Payment` deliberately never
   * touches any of those fields — approval is what makes a payment a real
   * accounting event (`FinanceService.approvePayment`) — so these four
   * fields alone cannot tell a caller "how much of this debt already has
   * a payment sitting in review."
   *
   * `pendingPaymentAmount` closes that gap: the sum of every
   * PENDING_APPROVAL Payment currently reported for the unit — REJECTED
   * payments never reserve anything (rejection was never accounting-
   * mutating to begin with, so there is nothing to release); APPROVED
   * payments already reduced `chargeItemDebt`/`adjustmentDebt` for real,
   * so counting them here too would double-reserve the same debt twice;
   * REVERSED/REFUNDED payments were APPROVED at the time (`PaymentPolicy`
   * only allows reversing/refunding an APPROVED payment), so they're
   * excluded by the same `PENDING_APPROVAL`-only filter without needing a
   * separate exclusion rule.
   *
   * `remainingPayable` is the actual answer to "how much should Mobile
   * auto-fill / accept as a new normal payment right now":
   * `max((totalDebt - creditBalance) - pendingPaymentAmount, 0)` — netting
   * out any existing credit first (the same "netDebt" concept the Charge
   * Payment Amount UX already established), then reserving whatever's
   * already pending, floored at zero so an already-covered (or
   * over-covered) unit never reports a negative remaining amount. This is
   * the single canonical figure both `FinanceRepository.createPayment`'s
   * own validation and Mobile's auto-fill must use — see that method's own
   * doc comment for why duplicating this math in Mobile is exactly the bug
   * class this correction closes.
   */
  async getUnitDebt(unitId: string) {
    return this.computeDebtSnapshot(this.prisma, unitId);
  }

  /** Fixed query count per bounded page; never calls the single-unit query loop. */
  async listUnitDebtSummaries(buildingId: string, pagination: { skip: number; take: number }) {
    const where = { buildingId };
    const [units, total] = await Promise.all([
      this.prisma.unit.findMany({
        where,
        select: { id: true },
        orderBy: [{ unitNumber: 'asc' }, { id: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.unit.count({ where }),
    ]);
    const unitIds = units.map((unit) => unit.id);
    if (unitIds.length === 0) return { items: [], total };

    const [chargeItems, adjustments, credits, pendingPayments] = await Promise.all([
      this.prisma.chargeItem.findMany({
        where: {
          unitId: { in: unitIds },
          status: { not: 'PAID' },
          chargeBatch: { status: { in: ['ISSUED', 'CLOSED'] } },
        },
        select: { unitId: true, amount: true, paidAmount: true },
      }),
      this.prisma.adjustment.findMany({
        where: { unitId: { in: unitIds }, amount: { gt: 0 } },
        select: { unitId: true, amount: true, paidAmount: true },
      }),
      this.prisma.creditBalance.findMany({
        where: { unitId: { in: unitIds } },
        select: { unitId: true, balance: true },
      }),
      this.prisma.payment.findMany({
        where: { unitId: { in: unitIds }, status: 'PENDING_APPROVAL' },
        select: { unitId: true, amount: true },
      }),
    ]);

    const groupByUnit = <T extends { unitId: string }>(rows: T[]) => {
      const grouped = new Map<string, T[]>();
      for (const row of rows) grouped.set(row.unitId, [...(grouped.get(row.unitId) ?? []), row]);
      return grouped;
    };
    const chargesByUnit = groupByUnit(chargeItems);
    const adjustmentsByUnit = groupByUnit(adjustments);
    const paymentsByUnit = groupByUnit(pendingPayments);
    const creditByUnit = new Map(credits.map((credit) => [credit.unitId, credit.balance]));

    return {
      items: unitIds.map((unitId) => ({
        unitId,
        remainingPayable: buildDebtSnapshot(
          chargesByUnit.get(unitId) ?? [],
          adjustmentsByUnit.get(unitId) ?? [],
          creditByUnit.get(unitId) ?? 0,
          paymentsByUnit.get(unitId) ?? [],
        ).remainingPayable,
      })),
      total,
    };
  }

  /**
   * Shared by `getUnitDebt` (read, outside any transaction) and
   * `createPayment` (write, computed INSIDE the same transaction that
   * holds the per-unit advisory lock — see that method's own doc comment)
   * so both the read endpoint and the write-path validation always agree
   * on exactly the same figures, computed by exactly the same query
   * shapes. `client` accepts either the plain `PrismaService` or a
   * `Prisma.TransactionClient` — a `PrismaService` structurally satisfies
   * `Prisma.TransactionClient`'s (smaller) shape, so `getUnitDebt` can pass
   * `this.prisma` directly with no cast, the same way
   * `DocumentRepository.consumeUploadIntent` accepts either.
   */
  private async computeDebtSnapshot(client: Prisma.TransactionClient, unitId: string) {
    const [outstandingItems, positiveAdjustments, credit, pendingPayments] = await Promise.all([
      client.chargeItem.findMany({
        where: {
          unitId,
          status: { not: 'PAID' },
          chargeBatch: { status: { in: ['ISSUED', 'CLOSED'] } },
        },
        select: { amount: true, paidAmount: true },
      }),
      client.adjustment.findMany({
        where: { unitId, amount: { gt: 0 } },
        select: { amount: true, paidAmount: true },
      }),
      client.creditBalance.findUnique({ where: { unitId } }),
      client.payment.findMany({
        where: { unitId, status: 'PENDING_APPROVAL' },
        select: { amount: true },
      }),
    ]);

    return buildDebtSnapshot(
      outstandingItems,
      positiveAdjustments,
      credit?.balance ?? 0,
      pendingPayments,
    );
  }

  /**
   * Finance Correction Pass — a unit's *effective opening balance* is
   * defined as the running sum of every Adjustment ever recorded against it
   * with `sourceType: 'OPENING_BALANCE_CORRECTION'` (mirroring how Funds
   * tag their own starting-point `OPENING_BALANCE` ledger entries — see
   * `Adjustment`'s own schema comment on why NULL `sourceId` never collides
   * with the `@@unique([sourceType, sourceId])` constraint, letting this
   * unit accumulate any number of corrections over time). Zero for a unit
   * that has never had a correction applied.
   */
  async getUnitOpeningBalanceCorrectionTotal(unitId: string): Promise<number> {
    const rows = await this.prisma.adjustment.findMany({
      where: { unitId, sourceType: 'OPENING_BALANCE_CORRECTION' },
      select: { amount: true },
    });
    return rows.reduce((sum, row) => sum + row.amount, 0);
  }

  // --- Payment Reversal & Refund (08.06 Rules 010/014/015 — ADR-037) ----------

  /**
   * REVERSED — undoes an erroneous/bounced/fraudulent APPROVED payment as
   * if it never happened: rolls back every `PaymentAllocation` this
   * payment made — decrementing the affected `ChargeItem.paidAmount`
   * (recomputing status) or, as of ADR-053, the affected positive
   * `Adjustment.paidAmount` (each row allocates to exactly one of the
   * two, never both), writes a REVERSAL counter-entry (08.06 Rule 014),
   * and decrements `Fund.balance`. Payments that generated unit credit
   * are not reversible in MVP because CreditBalance is pooled by unit and
   * cannot prove whether that payment's own credit remains unconsumed.
   *
   * FIN-MVP-GAP-03B — same `finance-payment:<unitId>` advisory-lock +
   * post-lock authoritative re-read pattern as `approvePayment`/
   * `rejectPayment` above: a concurrent reverse/refund/reverse against
   * the same payment now serializes on this lock instead of racing on
   * the unconditional `payment.update` this method used to open with.
   */
  reversePayment(params: {
    paymentId: string;
    buildingId: string;
    fundId: string;
    amount: number;
    actorId: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.payment.findUnique({ where: { id: params.paymentId } });
      if (!candidate) throw new BusinessRuleViolationError('Payment not found.');
      await this.acquireUnitFinanceLock(tx, candidate.unitId);
      const current = await tx.payment.findUnique({ where: { id: params.paymentId } });
      if (!current || current.status !== 'APPROVED') {
        throw new BusinessRuleViolationError('Only an approved payment can be reversed.');
      }

      const allocationAggregate = await tx.paymentAllocation.aggregate({
        where: { paymentId: current.id },
        _sum: { amount: true },
      });
      const allocatedTotal = allocationAggregate._sum.amount ?? 0;
      if (allocatedTotal > current.amount) {
        throw new BusinessRuleViolationError(
          'Payment allocation history exceeds the payment amount.',
        );
      }
      if (current.amount - allocatedTotal > 0) {
        throw new BusinessRuleViolationError(
          'Payments that generated unit credit cannot be reversed in MVP.',
        );
      }

      const payment = await tx.payment.update({
        where: { id: params.paymentId },
        data: { status: 'REVERSED', reversedAt: new Date() },
      });

      const allocations = await tx.paymentAllocation.findMany({
        where: { paymentId: params.paymentId },
      });
      for (const alloc of allocations) {
        if (alloc.chargeItemId) {
          const item = await tx.chargeItem.findUnique({ where: { id: alloc.chargeItemId } });
          if (item) {
            const newPaidAmount = Math.max(0, item.paidAmount - alloc.amount);
            await tx.chargeItem.update({
              where: { id: item.id },
              data: {
                paidAmount: newPaidAmount,
                status: computeItemStatus(newPaidAmount, item.amount),
              },
            });
          }
        } else if (alloc.adjustmentId) {
          const adjustment = await tx.adjustment.findUnique({ where: { id: alloc.adjustmentId } });
          if (adjustment) {
            const newPaidAmount = Math.max(0, adjustment.paidAmount - alloc.amount);
            await tx.adjustment.update({
              where: { id: adjustment.id },
              data: { paidAmount: newPaidAmount },
            });
          }
        }
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'REVERSAL',
          direction: 'DEBIT',
          amount: params.amount,
          referenceType: 'Payment',
          referenceId: params.paymentId,
          actorId: params.actorId,
          requestId: params.requestId,
        },
      });

      await tx.fund.update({
        where: { id: params.fundId },
        data: { balance: { decrement: params.amount } },
      });

      return payment;
    });
  }

  /**
   * REFUNDED — cash genuinely returned to the payer after a valid
   * APPROVED payment. Deliberately does NOT touch `PaymentAllocation` or
   * `ChargeItem.paidAmount` (08.06 Rule 015 — see this file's own
   * `Refund` model schema comment for the reconciliation gap this can
   * create and why it's disclosed, not silently resolved).
   *
   * FIN-MVP-GAP-03B — same `finance-payment:<unitId>` advisory lock as
   * `reversePayment`/`approvePayment`/`rejectPayment` (same namespace on
   * purpose, so a concurrent reverse and refund against the same payment
   * serialize against each other, not just refund-vs-refund), plus a
   * post-lock authoritative re-read of `Payment.status` and the
   * "at most one refund" check — both previously only checked once,
   * before this transaction opened, in `FinanceService.refundPayment`.
   */
  createRefund(params: {
    paymentId: string;
    unitId: string;
    buildingId: string;
    fundId: string;
    amount: number;
    paymentAmount: number;
    reason: string;
    createdById: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.acquireUnitFinanceLock(tx, params.unitId);

      const current = await tx.payment.findUnique({ where: { id: params.paymentId } });
      if (!current || current.status !== 'APPROVED') {
        throw new BusinessRuleViolationError('Only an approved payment can be refunded.');
      }

      const allocationAggregate = await tx.paymentAllocation.aggregate({
        where: { paymentId: current.id },
        _sum: { amount: true },
      });
      const allocatedTotal = allocationAggregate._sum.amount ?? 0;
      if (allocatedTotal > current.amount) {
        throw new BusinessRuleViolationError(
          'Payment allocation history exceeds the payment amount.',
        );
      }
      if (current.amount - allocatedTotal > 0) {
        throw new BusinessRuleViolationError(
          'Payments that generated unit credit cannot be refunded in MVP.',
        );
      }
      if (allocatedTotal > 0) {
        throw new BusinessRuleViolationError(
          'Payments allocated to obligations cannot be refunded in MVP.',
        );
      }

      const existingRefunds = await tx.refund.findMany({ where: { paymentId: params.paymentId } });
      if (existingRefunds.length > 0) {
        throw new BusinessRuleViolationError('This payment has already been refunded.');
      }

      const refund = await tx.refund.create({
        data: {
          paymentId: params.paymentId,
          unitId: params.unitId,
          buildingId: params.buildingId,
          amount: params.amount,
          reason: params.reason,
          createdById: params.createdById,
        },
      });

      // Payment.status only moves to REFUNDED when this refund exhausts the
      // full original amount — a partial refund leaves the payment APPROVED
      // (it's still a fundamentally valid, mostly-kept payment), which also
      // keeps `getFinancialSummary`'s APPROVED-status aggregate accurate for
      // the unrefunded portion. Policy still refuses a second refund either
      // way (see PaymentPolicy.assertRefundable's `alreadyRefunded` check),
      // so this MVP never needs to track "how much of this payment is still
      // refundable."
      if (params.amount >= params.paymentAmount) {
        await tx.payment.update({ where: { id: params.paymentId }, data: { status: 'REFUNDED' } });
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'REFUND',
          direction: 'DEBIT',
          amount: params.amount,
          referenceType: 'Refund',
          referenceId: refund.id,
          actorId: params.createdById,
          requestId: params.requestId,
        },
      });

      await tx.fund.update({
        where: { id: params.fundId },
        data: { balance: { decrement: params.amount } },
      });

      return refund;
    });
  }

  findRefundsByPayment(paymentId: string) {
    return this.prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Finance Hardening Pass — paginated variant of `findRefundsByPayment`,
   * see `listFunds`'s own doc comment. `findRefundsByPayment` (unpaginated)
   * stays as-is: it's also used internally by `FinanceRepository`/
   * `FinanceService` write paths (`refundPayment`'s `alreadyRefunded`
   * check) where a full, unbounded read is actually correct — a payment
   * has at most one Refund this MVP (`Refund`'s own schema comment), so
   * that internal use was never the unbounded-listing risk the audit
   * flagged; only the public `GET .../refunds` read needed a page/limit
   * escape hatch for consistency with every other Finance list route.
   */
  async listRefundsByPayment(paymentId: string, pagination: { skip: number; take: number }) {
    const where = { paymentId };
    const [items, total] = await Promise.all([
      this.prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { items, total };
  }

  // --- Expenses / Disbursements (FIN-EXP-01/FIN-EXP-02 -- see 21_ADRs > ADR-126) ---

  /**
   * Fund-sufficiency is re-checked HERE, inside the transaction, against
   * a fresh `tx.fund` read -- not the pre-fetched copy the service layer's
   * `ExpensePolicy.assertSufficientFundBalance` pre-check used -- so a
   * concurrent write that shrinks the balance in the gap between that
   * pre-check and this transaction can never drive `Fund.balance`
   * negative (same fast-pre-check / authoritative-check split
   * `VotingService.closeVote` already establishes for a different race).
   *
   * Idempotency: if `params.idempotencyKey` is set and the `tx.expense.
   * create` below hits a `P2002` unique violation (a genuine retry of the
   * same request), this method lets that error propagate out of the
   * transaction (which rolls back atomically -- no LedgerEntry or Fund
   * balance change survives a rolled-back transaction). The SERVICE layer
   * catches that `P2002` outside the transaction and re-fetches the
   * original Expense by `idempotencyKey` instead of raising -- the exact
   * same `isUniqueConstraintViolation` pattern already used for
   * Adjustment's `sourceType`/`sourceId` race (see
   * `FinanceService.applyLateFee`).
   */
  createExpense(params: {
    buildingId: string;
    fundId: string;
    title: string;
    description?: string;
    category: ExpenseCategory;
    amount: number;
    occurredAt: Date;
    createdById: string;
    idempotencyKey?: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const fund = await tx.fund.findUniqueOrThrow({ where: { id: params.fundId } });
      if (fund.balance < params.amount) {
        throw new BusinessRuleViolationError(
          "This expense's amount exceeds the fund's current balance.",
        );
      }

      const expense = await tx.expense.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          title: params.title,
          description: params.description,
          category: params.category,
          amount: params.amount,
          occurredAt: params.occurredAt,
          createdById: params.createdById,
          idempotencyKey: params.idempotencyKey,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'EXPENSE',
          direction: 'DEBIT',
          amount: params.amount,
          referenceType: 'Expense',
          referenceId: expense.id,
          actorId: params.createdById,
          requestId: params.requestId,
        },
      });

      await tx.fund.update({
        where: { id: params.fundId },
        data: { balance: { decrement: params.amount } },
      });

      return expense;
    });
  }

  findExpenseById(id: string) {
    return this.prisma.expense.findUnique({ where: { id } });
  }

  findExpenseByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.expense.findUnique({ where: { idempotencyKey } });
  }

  /**
   * Concurrency-safe against two simultaneous voids of the same Expense --
   * the `updateMany({ where: { id, status: 'POSTED' } })` CAS below is the
   * same "expected-status" pattern `VotingRepository.closeVote`/
   * `CaseRepository.resolveCase`/`closeCase` already establish. Only ONE
   * of two racing void calls can ever win the `count === 1` check; the
   * loser gets a clean `ConflictError` (409) instead of both silently
   * posting a second CREDIT counter-entry and double-crediting
   * `Fund.balance`. This is deliberately the same primitive those
   * repositories use, not the simpler read-then-conditionally-write shape
   * a plain application-level status check would use elsewhere in this
   * file (e.g. `FundPolicy.assertActive`) -- Expense void needs the
   * stronger guarantee because, unlike those checks, a lost race here
   * would corrupt real money, not just an inactive-fund UX message.
   */
  voidExpense(params: {
    expenseId: string;
    buildingId: string;
    fundId: string;
    amount: number;
    voidReason: string;
    actorId: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.expense.updateMany({
        where: { id: params.expenseId, status: 'POSTED' },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedById: params.actorId,
          voidReason: params.voidReason,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictError(
          'This expense is no longer POSTED (it may have already been voided). Reload and retry.',
        );
      }

      await tx.ledgerEntry.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          entryType: 'EXPENSE',
          direction: 'CREDIT',
          amount: params.amount,
          referenceType: 'Expense',
          referenceId: params.expenseId,
          description: 'Expense voided',
          actorId: params.actorId,
          requestId: params.requestId,
        },
      });

      await tx.fund.update({
        where: { id: params.fundId },
        data: { balance: { increment: params.amount } },
      });

      return tx.expense.findUniqueOrThrow({ where: { id: params.expenseId } });
    });
  }

  /**
   * Finance Hardening Pass style pagination (see `listFunds`'s own doc
   * comment). `status` defaults to excluding VOIDED unless explicitly
   * requested, matching how `listPayments` accepts an optional
   * `?status=` filter; both are backed by the new `@@index([buildingId,
   * status])`/`@@index([buildingId, category])` on `Expense`.
   */
  async listExpenses(
    buildingId: string,
    pagination: { skip: number; take: number },
    filters?: {
      fundId?: string;
      category?: ExpenseCategory;
      status?: ExpenseStatus;
      fromDate?: Date;
      toDate?: Date;
    },
  ) {
    const where: Prisma.ExpenseWhereInput = {
      buildingId,
      ...(filters?.fundId ? { fundId: filters.fundId } : {}),
      ...(filters?.category ? { category: filters.category } : {}),
      status: filters?.status ?? 'POSTED',
      ...(filters?.fromDate || filters?.toDate
        ? {
            occurredAt: {
              ...(filters?.fromDate ? { gte: filters.fromDate } : {}),
              ...(filters?.toDate ? { lte: filters.toDate } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.expense.count({ where }),
    ]);
    return { items, total };
  }

  // --- Reporting ---------------------------------------------------------------

  async getFinancialSummary(buildingId: string) {
    const [
      funds,
      outstandingItems,
      positiveAdjustments,
      collected,
      refunded,
      chargeBatchCount,
      expensed,
    ] = await Promise.all([
      this.prisma.fund.findMany({ where: { buildingId } }),
      this.prisma.chargeItem.findMany({
        where: {
          chargeBatch: { buildingId, status: { in: ['ISSUED', 'CLOSED'] } },
          status: { not: 'PAID' },
        },
        select: { amount: true, paidAmount: true },
      }),
      this.prisma.adjustment.aggregate({
        where: { buildingId, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { buildingId, status: 'APPROVED' },
        _sum: { amount: true },
      }),
      // A payment's `amount` field only ever reflects the ORIGINAL amount
      // (never edited — 08.06 Rule 015), so an APPROVED-and-partially-
      // refunded payment (status stays APPROVED — see `createRefund`'s own
      // comment) still counts its full original amount above; subtracting
      // ITS refund here is what makes `totalCollected` net-accurate. A
      // FULLY-refunded payment's status is REFUNDED, not APPROVED, so it's
      // already excluded by the aggregate above — filtering this second
      // aggregate to `payment.status: 'APPROVED'` too avoids subtracting
      // that refund a second time (which would double-count it).
      this.prisma.refund.aggregate({
        where: { buildingId, payment: { status: 'APPROVED' } },
        _sum: { amount: true },
      }),
      this.prisma.chargeBatch.count({ where: { buildingId } }),
      // FIN-EXP-02 — only POSTED Expenses count; a VOIDED one's cash
      // effect was already reversed by its own counter LedgerEntry, so
      // including it here would double-subtract.
      this.prisma.expense.aggregate({
        where: { buildingId, status: 'POSTED' },
        _sum: { amount: true },
      }),
    ]);

    const chargeItemOutstanding = outstandingItems.reduce(
      (sum, i) => sum + (i.amount - i.paidAmount),
      0,
    );
    const totalOutstanding = chargeItemOutstanding + (positiveAdjustments._sum.amount ?? 0);

    return {
      funds,
      totalOutstanding,
      totalCollected: (collected._sum.amount ?? 0) - (refunded._sum.amount ?? 0),
      totalExpenses: expensed._sum.amount ?? 0,
      chargeBatchCount,
    };
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  async listLedger(
    buildingId: string,
    fundId: string | undefined,
    pagination: { skip: number; take: number },
  ) {
    const where = { buildingId, ...(fundId ? { fundId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * 21_ADRs > ADR-055 — `12_Finance_Architecture_v2.0`'s "Financial Reports"
   * example list names Collection Rate alongside Income Statement/Cash Flow/
   * etc.; unlike those, it's a single literal ratio computable from fields
   * that have existed since ADR-023 (`ChargeItem.amount`/`paidAmount`), so
   * it's the one item of that list built this round — the rest stay
   * deferred, blocked on domains/categorizations no source doc specifies
   * (see ADR-055 Context for the full split).
   *
   * `ChargeItem` has no direct `buildingId` — scoped the same way
   * `getFinancialSummary` already scopes `outstandingItems`, via
   * `chargeBatch: { buildingId }`. An optional `[fromDate, toDate]` window
   * filters on `ChargeItem.createdAt`, the same optional-date-window shape
   * `getFraudCaseMetrics`/`getSupportCaseMetrics` already established.
   * `collectionRate` returns `null`, not `0`, when nothing was billed in
   * the window — the same zero-denominator convention those two use.
   */
  async getCollectionRate(buildingId: string, fromDate?: Date, toDate?: Date) {
    const dateFilter =
      fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {};

    const result = await this.prisma.chargeItem.aggregate({
      where: { chargeBatch: { buildingId }, ...dateFilter },
      _sum: { amount: true, paidAmount: true },
    });

    const totalBilled = result._sum.amount ?? 0;
    const totalCollected = result._sum.paidAmount ?? 0;

    return {
      totalBilled,
      totalCollected,
      collectionRate: totalBilled > 0 ? totalCollected / totalBilled : null,
    };
  }

  /**
   * 21_ADRs > ADR-057 — `02_MVP_Scope_v2.0`'s MVP Success Metrics (Financial)
   * names `Payment Registration Rate` as Collection Rate's sibling KPI; this
   * is the exact same shape as `getCollectionRate` (ADR-055), one aggregate
   * query further: `totalRegistered ÷ totalBilled`, where `totalRegistered`
   * sums every `Payment.amount` reported in the window regardless of its
   * eventual `status`. A Payment row is created at report time (`status`
   * starts `PENDING_APPROVAL` — see the `Payment` model's own doc comment)
   * BEFORE any approve/reject/reverse/refund outcome is known, so
   * "registered" means "a resident reported it," not "it was approved" —
   * approval is what Collection Rate already measures via `paidAmount`.
   * Counting every status (including REJECTED/REVERSED/REFUNDED) is a
   * disclosed field-based inclusion choice, not an invented formula — see
   * ADR-057 Decision for the full reasoning.
   *
   * Unlike `ChargeItem`, `Payment` has a direct `buildingId` (no indirect
   * `chargeBatch` scoping needed). `totalBilled` reuses the identical
   * `ChargeItem.amount` sum `getCollectionRate` already computes, so both
   * rates share one denominator source. `null`, not `0`, on a zero-billed
   * window — the same convention every metrics method in this series uses.
   */
  async getPaymentRegistrationRate(buildingId: string, fromDate?: Date, toDate?: Date) {
    const dateFilter =
      fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {};

    const [billedResult, registeredResult] = await Promise.all([
      this.prisma.chargeItem.aggregate({
        where: { chargeBatch: { buildingId }, ...dateFilter },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { buildingId, ...dateFilter },
        _sum: { amount: true },
      }),
    ]);

    const totalBilled = billedResult._sum.amount ?? 0;
    const totalRegistered = registeredResult._sum.amount ?? 0;

    return {
      totalBilled,
      totalRegistered,
      paymentRegistrationRate: totalBilled > 0 ? totalRegistered / totalBilled : null,
    };
  }
}
