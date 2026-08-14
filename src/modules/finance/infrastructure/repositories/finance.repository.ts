import { Injectable } from '@nestjs/common';
import {
  ChargeCalculationMethod,
  ChargeItemStatus,
  ChargePayerType,
  ChargeUnitScope,
  FundAccountLinkType,
  FundType,
  LateFeeType,
  LedgerEntryType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

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
 */
function affectsFundBalance(entryType: LedgerEntryType): boolean {
  return entryType === 'PAYMENT' || entryType === 'REFUND' || entryType === 'REVERSAL';
}

function computeItemStatus(paidAmount: number, amount: number): ChargeItemStatus {
  if (paidAmount <= 0) return 'UNPAID';
  if (paidAmount >= amount) return 'PAID';
  return 'PARTIALLY_PAID';
}

@Injectable()
export class FinanceRepository {
  constructor(private readonly prisma: PrismaService) {}

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

  /** Creates a DRAFT batch and its ChargeItems atomically; totalAmount is the sum of `items`. */
  createChargeBatch(params: {
    buildingId: string;
    fundId: string;
    title: string;
    description?: string;
    calculationMethod: ChargeCalculationMethod;
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
      const batch = await tx.chargeBatch.create({
        data: {
          buildingId: params.buildingId,
          fundId: params.fundId,
          title: params.title,
          description: params.description,
          calculationMethod: params.calculationMethod,
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
      where: { unitId, status: { not: 'PAID' } },
      select: {
        id: true,
        amount: true,
        paidAmount: true,
        chargeBatch: {
          select: { status: true, dueDate: true, lateFeeType: true, lateFeeValue: true, lateFeeGraceDays: true },
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

  hasAnyPaidChargeItems(chargeBatchId: string): Promise<boolean> {
    return this.prisma.chargeItem
      .count({ where: { chargeBatchId, paidAmount: { gt: 0 } } })
      .then((count) => count > 0);
  }

  cancelChargeBatch(id: string) {
    return this.prisma.chargeBatch.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
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
      const batch = await tx.chargeBatch.update({
        where: { id: params.chargeBatchId },
        data: { status: 'ISSUED', issuedAt: new Date() },
      });

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

      const items = await tx.chargeItem.findMany({
        where: { chargeBatchId: params.chargeBatchId },
      });

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
        await tx.creditBalance.update({
          where: { unitId: item.unitId },
          data: { balance: credit.balance - applied },
        });
        await tx.ledgerEntry.create({
          data: {
            buildingId: params.buildingId,
            fundId: params.fundId,
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
          fundId: params.fundId,
          entryType: 'CHARGE',
          direction: 'DEBIT',
          amount: params.totalAmount,
          referenceType: 'ChargeBatch',
          referenceId: params.chargeBatchId,
          actorId: params.actorId,
          requestId: params.requestId,
        },
      });

      return batch;
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
   */
  createPayment(params: {
    buildingId: string;
    unitId: string;
    fundId: string;
    payerId: string;
    amount: number;
    method: PaymentMethod;
    reference?: string;
    note?: string;
    isManualAmount: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'finance-payment:' + params.unitId}))`;

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
          status: 'PENDING_APPROVAL',
        },
      });
    });
  }

  findPaymentById(id: string) {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  /**
   * Finance Hardening Pass — paginated, see `listFunds`'s own doc comment.
   * Backend ↔ Mobile Contract Alignment — optional `status` filter, backed
   * by the pre-existing `@@index([buildingId, status])` on `Payment`
   * (added independently of this change, confirmed by direct schema read —
   * no new index or migration needed for this filter to be cheap).
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
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items, total };
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  async listPaymentsByUnit(unitId: string, pagination: { skip: number; take: number }) {
    const where = { unitId };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items, total };
  }

  rejectPayment(id: string, reason?: string) {
    return this.prisma.payment.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
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
      const payment = await tx.payment.update({
        where: { id: params.paymentId },
        data: { status: 'APPROVED', approvedById: params.actorId, approvedAt: new Date() },
      });

      // Oldest-debt-first: earliest due date, then earliest created. Nested
      // relation ordering on `chargeBatch.dueDate` — a DRAFT/never-issued
      // batch has no items yet so this only ever sees ISSUED batches.
      const outstandingItems = await tx.chargeItem.findMany({
        where: { unitId: params.unitId, status: { not: 'PAID' } },
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
          where: { unitId: params.unitId, status: { not: 'PAID' } },
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
    amount: number;
    reason: string;
    createdById: string;
    requestId?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const adjustment = await tx.adjustment.create({
        data: {
          unitId: params.unitId,
          buildingId: params.buildingId,
          fundId: params.fundId,
          amount: params.amount,
          reason: params.reason,
          createdById: params.createdById,
          sourceType: 'OPENING_BALANCE_CORRECTION',
        },
      });

      if (params.amount < 0) {
        let remaining = Math.abs(params.amount);

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
        where: { unitId, status: { not: 'PAID' } },
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

    const chargeItemDebt = outstandingItems.reduce((sum, i) => sum + (i.amount - i.paidAmount), 0);
    const adjustmentDebt = positiveAdjustments.reduce(
      (sum, a) => sum + Math.max(0, a.amount - a.paidAmount),
      0,
    );
    const totalDebt = chargeItemDebt + adjustmentDebt;
    const creditBalance = credit?.balance ?? 0;
    const pendingPaymentAmount = pendingPayments.reduce((sum, p) => sum + p.amount, 0);
    const remainingPayable = Math.max(totalDebt - creditBalance - pendingPaymentAmount, 0);

    return {
      chargeItemDebt,
      adjustmentDebt,
      totalDebt,
      creditBalance,
      pendingPaymentAmount,
      remainingPayable,
    };
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
   * two, never both) — rolls back any overflow that had banked into
   * `CreditBalance` (clamped at 0), writes a REVERSAL counter-entry
   * (08.06 Rule 014), and decrements `Fund.balance`. Disclosed edge case:
   * if credit from this payment's overflow was already spent against a
   * later charge, clamping at 0 is the honest floor this MVP can offer —
   * there's no per-source tracking of which credit came from which
   * payment to claw back more precisely.
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
      const payment = await tx.payment.update({
        where: { id: params.paymentId },
        data: { status: 'REVERSED', reversedAt: new Date() },
      });

      const allocations = await tx.paymentAllocation.findMany({
        where: { paymentId: params.paymentId },
      });
      let totalAllocated = 0;
      for (const alloc of allocations) {
        totalAllocated += alloc.amount;
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

      const overflow = params.amount - totalAllocated;
      if (overflow > 0) {
        const credit = await tx.creditBalance.findUnique({ where: { unitId: payment.unitId } });
        if (credit) {
          const newBalance = Math.max(0, credit.balance - overflow);
          await tx.creditBalance.update({
            where: { unitId: payment.unitId },
            data: { balance: newBalance },
          });
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

  // --- Reporting ---------------------------------------------------------------

  async getFinancialSummary(buildingId: string) {
    const [funds, outstandingItems, positiveAdjustments, collected, refunded, chargeBatchCount] =
      await Promise.all([
        this.prisma.fund.findMany({ where: { buildingId } }),
        this.prisma.chargeItem.findMany({
          where: { chargeBatch: { buildingId }, status: { not: 'PAID' } },
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
