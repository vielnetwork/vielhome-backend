import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { FinanceRepository } from '../infrastructure/repositories/finance.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { ChargePolicy } from '../domain/policies/charge.policy';
import { PaymentPolicy } from '../domain/policies/payment.policy';
import { FundPolicy } from '../domain/policies/fund.policy';
import { CreateFundDto } from './dto/create-fund.dto';
import { UpdateFundDto } from './dto/update-fund.dto';
import { CreateChargeBatchDto } from './dto/create-charge-batch.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { ReversePaymentDto } from './dto/reverse-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { AuditService } from '../../../common/audit/audit.service';
import {
  BusinessRuleViolationError,
  DuplicateError,
  NotFoundAppError,
} from '../../../common/errors/app-error';

/** ADR-095 — defensive backstop against `Adjustment`'s `@@unique([sourceType, sourceId])` racing a concurrent duplicate late-fee application; the `findAdjustmentBySource` pre-check in `applyLateFee` handles the non-concurrent case. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
import { ChargeBatchCancelledEvent, ChargeBatchIssuedEvent } from '../events/charge-batch.events';
import {
  PaymentApprovedEvent,
  PaymentRefundedEvent,
  PaymentRejectedEvent,
  PaymentReversedEvent,
} from '../events/payment.events';
import { AdjustmentCreatedEvent } from '../events/adjustment.events';

@Injectable()
export class FinanceService {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly buildings: BuildingRepository,
    private readonly chargePolicy: ChargePolicy,
    private readonly paymentPolicy: PaymentPolicy,
    private readonly fundPolicy: FundPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  // --- Funds -----------------------------------------------------------------

  async createFund(
    buildingId: string,
    dto: CreateFundDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);

    const fund = await this.finance.createFund({
      buildingId,
      name: dto.name,
      type: dto.type,
      description: dto.description,
      initialBalance: dto.initialBalance,
      accountLinkType: dto.accountLinkType,
      accountReference: dto.accountReference,
      actorId: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'FundCreated',
      entityType: 'Fund',
      entityId: fund.id,
      requestId,
      metadata: dto.initialBalance ? { initialBalance: dto.initialBalance } : undefined,
    });

    return fund;
  }

  listFunds(buildingId: string) {
    return this.finance.listFunds(buildingId);
  }

  /** Same not-found-or-wrong-building guard shape as `getChargeBatch`. */
  async getFund(buildingId: string, fundId: string) {
    const fund = await this.finance.findFundById(fundId);
    if (!fund || fund.buildingId !== buildingId) {
      throw new NotFoundAppError('Fund not found.');
    }
    return fund;
  }

  async updateFund(
    buildingId: string,
    fundId: string,
    dto: UpdateFundDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const existing = await this.getFund(buildingId, fundId);
    this.fundPolicy.assertActive(existing.isActive);

    const fund = await this.finance.updateFund(fundId, {
      name: dto.name,
      type: dto.type,
      description: dto.description,
      accountLinkType: dto.accountLinkType,
      accountReference: dto.accountReference,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'FundUpdated',
      entityType: 'Fund',
      entityId: fundId,
      requestId,
    });

    return fund;
  }

  async deactivateFund(
    buildingId: string,
    fundId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const existing = await this.getFund(buildingId, fundId);
    this.fundPolicy.assertDeactivatable(existing.isDefault);

    const fund = await this.finance.setFundActive(fundId, false);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'FundDeactivated',
      entityType: 'Fund',
      entityId: fundId,
      requestId,
    });

    return fund;
  }

  async reactivateFund(
    buildingId: string,
    fundId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getFund(buildingId, fundId);

    const fund = await this.finance.setFundActive(fundId, true);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'FundReactivated',
      entityType: 'Fund',
      entityId: fundId,
      requestId,
    });

    return fund;
  }

  // --- Charge Batches ----------------------------------------------------------

  /**
   * Resolves calculationMethod -> the concrete per-unit item list. See
   * CreateChargeBatchDto's class comment for what each method expects.
   * ADR-095 (Sprint 29, Charge Generation Phase 2) — also resolves
   * `unitScope` for FIXED/AREA_BASED. An omitted `unitScope` resolves to
   * ALL right here, never at the DTO layer (see CreateChargeBatchDto.
   * unitScope's own comment for why) — MIXED never reaches this
   * resolution at all, since `ChargePolicy` rejects unitScope/unitIds
   * combined with MIXED before this point. Shared verbatim by
   * `createChargeBatch` and `previewChargeBatch` so the two can never
   * structurally drift.
   */
  private async resolveChargeItems(
    buildingId: string,
    dto: CreateChargeBatchDto,
  ): Promise<{
    items: Array<{ unitId: string; amount: number }>;
    effectiveUnitScope: CreateChargeBatchDto['unitScope'] | null;
  }> {
    this.chargePolicy.assertValidCalculationInputs(dto.calculationMethod, dto);

    if (dto.calculationMethod === 'MIXED') {
      return {
        items: dto.items!.map((i) => ({ unitId: i.unitId, amount: i.amount })),
        effectiveUnitScope: null,
      };
    }

    const allUnits = await this.buildings.listUnits(buildingId);
    const effectiveUnitScope = dto.unitScope ?? 'ALL';
    const units = this.filterUnitsByScope(allUnits, effectiveUnitScope, dto.unitIds);

    if (dto.calculationMethod === 'FIXED') {
      return {
        items: units.map((u) => ({ unitId: u.id, amount: dto.amountPerUnit! })),
        effectiveUnitScope,
      };
    }

    // AREA_BASED — units with no areaSqm configured yet are skipped rather
    // than charged 0 (06_User_Flows: area is a "Configure Units" follow-up,
    // not guaranteed at skeleton-unit creation time).
    return {
      items: units
        .filter((u) => u.areaSqm && u.areaSqm > 0)
        .map((u) => ({ unitId: u.id, amount: Math.round(dto.ratePerSqm! * (u.areaSqm as number)) })),
      effectiveUnitScope,
    };
  }

  /** ADR-095 — MANUAL is checked against the building's real unit list, never trusted blindly (`ChargePolicy.assertUnitsBelongToBuilding`). */
  private filterUnitsByScope<T extends { id: string; type: string }>(
    units: T[],
    scope: string,
    unitIds: string[] | undefined,
  ): T[] {
    if (scope === 'ALL') return units;
    if (scope === 'MANUAL') {
      this.chargePolicy.assertUnitsBelongToBuilding(unitIds!, new Set(units.map((u) => u.id)));
      const idSet = new Set(unitIds);
      return units.filter((u) => idSet.has(u.id));
    }
    return units.filter((u) => u.type === scope);
  }

  /**
   * ADR-095 — resolves who a unit's charge is attributed to (informational
   * only, see ChargeBatch.payerType's own comment). TENANT falls back to
   * OWNER — snapshotting ALL current owners, never picking one arbitrarily,
   * since this schema has never enforced single-ownership-per-unit (see
   * `Ownership`'s own schema comment). Shared verbatim by
   * `previewChargeBatch` (display-only) and `issueChargeBatch` (persisted
   * snapshot) — same function, so the two can only ever differ because the
   * underlying ownership/tenancy data changed between calls, never because
   * the resolution logic differs.
   */
  private async resolvePayers(
    unitId: string,
    payerType: CreateChargeBatchDto['payerType'],
  ): Promise<{ resolvedPayerType: 'OWNER' | 'TENANT'; personIds: string[] } | null> {
    if (!payerType) return null;

    if (payerType === 'TENANT') {
      const tenancy = await this.buildings.findCurrentTenancyForUnit(unitId);
      if (tenancy) {
        return { resolvedPayerType: 'TENANT', personIds: [tenancy.personId] };
      }
    }

    const ownerIds = await this.buildings.getCurrentOwnerPersonIds(unitId);
    return { resolvedPayerType: 'OWNER', personIds: ownerIds };
  }

  async createChargeBatch(
    buildingId: string,
    dto: CreateChargeBatchDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);

    const fund = dto.fundId
      ? await this.finance.findFundById(dto.fundId)
      : await this.finance.getOrCreateDefaultFund(buildingId);
    if (!fund || fund.buildingId !== buildingId) {
      throw new NotFoundAppError('Fund not found.');
    }

    const { items, effectiveUnitScope } = await this.resolveChargeItems(buildingId, dto);

    const batch = await this.finance.createChargeBatch({
      buildingId,
      fundId: fund.id,
      title: dto.title,
      description: dto.description,
      calculationMethod: dto.calculationMethod,
      periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined,
      periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      createdById: actorPersonId,
      items,
      unitScope: effectiveUnitScope ?? undefined,
      payerType: dto.payerType,
      lateFeeType: dto.lateFeeType,
      lateFeeValue: dto.lateFeeValue,
      lateFeeGraceDays: dto.lateFeeGraceDays,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ChargeBatchCreated',
      entityType: 'ChargeBatch',
      entityId: batch.id,
      requestId,
      metadata: {
        calculationMethod: dto.calculationMethod,
        itemCount: items.length,
        unitScope: effectiveUnitScope,
        payerType: dto.payerType,
      },
    });

    return batch;
  }

  /**
   * ADR-095 — zero-write preview: no ChargeBatch/ChargeItem/Adjustment/
   * LedgerEntry/AuditLog row is ever created, and no domain event is
   * emitted. Uses the exact same `resolveChargeItems`/`resolvePayers`
   * private methods the real `createChargeBatch`/`issueChargeBatch` use,
   * so preview and the real batch can never structurally drift. Uses
   * `findDefaultFund` (read-only) instead of `getOrCreateDefaultFund` —
   * the latter creates a Fund row as a side effect, which preview must
   * never do; a missing default fund is surfaced as `willCreateDefaultFund`
   * instead, created for real only by the actual `createChargeBatch` call.
   */
  async previewChargeBatch(buildingId: string, dto: CreateChargeBatchDto) {
    await this.getBuilding(buildingId);

    let fund: { id: string; name: string } | null = null;
    let willCreateDefaultFund = false;
    if (dto.fundId) {
      const found = await this.finance.findFundById(dto.fundId);
      if (!found || found.buildingId !== buildingId) {
        throw new NotFoundAppError('Fund not found.');
      }
      fund = { id: found.id, name: found.name };
    } else {
      const found = await this.finance.findDefaultFund(buildingId);
      if (found) {
        fund = { id: found.id, name: found.name };
      } else {
        willCreateDefaultFund = true;
      }
    }

    const { items, effectiveUnitScope } = await this.resolveChargeItems(buildingId, dto);
    const allUnits = await this.buildings.listUnits(buildingId);
    const unitById = new Map(allUnits.map((u) => [u.id, u]));

    const previewItems = await Promise.all(
      items.map(async (item) => {
        const unit = unitById.get(item.unitId);
        const payer = await this.resolvePayers(item.unitId, dto.payerType);
        return {
          unitId: item.unitId,
          unitNumber: unit?.unitNumber ?? null,
          unitType: unit?.type ?? null,
          amount: item.amount,
          resolvedPayerType: payer?.resolvedPayerType ?? null,
          payerPersonIds: payer?.personIds ?? [],
        };
      }),
    );

    const validationWarnings: string[] = [];
    if (willCreateDefaultFund) {
      validationWarnings.push(
        'No default fund exists for this building yet — one will be created automatically when this charge batch is actually issued via createChargeBatch, not by this preview.',
      );
    }
    const noOwnerCount = previewItems.filter(
      (i) => i.resolvedPayerType === 'OWNER' && i.payerPersonIds.length === 0,
    ).length;
    if (noOwnerCount > 0) {
      validationWarnings.push(`${noOwnerCount} unit(s) have no current owner on record.`);
    }
    if (previewItems.length === 0) {
      validationWarnings.push('No units matched the requested scope — this batch would have zero items.');
    }

    return {
      fund,
      willCreateDefaultFund,
      unitScope: effectiveUnitScope,
      calculationMethod: dto.calculationMethod,
      items: previewItems,
      totalUnitCount: previewItems.length,
      grandTotal: previewItems.reduce((sum, i) => sum + i.amount, 0),
      lateFeePolicy: dto.lateFeeType
        ? { type: dto.lateFeeType, value: dto.lateFeeValue, graceDays: dto.lateFeeGraceDays ?? 0 }
        : null,
      validationWarnings,
    };
  }

  listChargeBatches(buildingId: string) {
    return this.finance.listChargeBatches(buildingId);
  }

  async getChargeBatch(buildingId: string, chargeBatchId: string) {
    const batch = await this.finance.findChargeBatchById(chargeBatchId);
    if (!batch || batch.buildingId !== buildingId) {
      throw new NotFoundAppError('Charge batch not found.');
    }
    return batch;
  }

  async issueChargeBatch(
    buildingId: string,
    chargeBatchId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const batch = await this.getChargeBatch(buildingId, chargeBatchId);
    this.chargePolicy.assertIssuable(batch.status, batch.totalAmount);

    // ADR-095 — the payer snapshot is resolved HERE, at issue time, never
    // at DRAFT creation (a draft can sit unissued for days — see
    // ChargeBatch.payerType's own schema comment). Resolved in the
    // service (BuildingRepository's ownership/tenancy lookups aren't
    // available to FinanceRepository) but written inside the SAME atomic
    // transaction as the status flip, by passing the resolution into
    // `finance.issueChargeBatch` below.
    let payerResolutions: Array<{
      chargeItemId: string;
      resolvedPayerType: 'OWNER' | 'TENANT';
      personIds: string[];
    }> = [];
    // Narrowed into a local const before the closure below — TS narrowing
    // on a property access (`batch.payerType`) does not persist inside a
    // nested arrow function, since the property could in principle change
    // between the check and the closure running; a local const doesn't
    // have that ambiguity.
    const requestedPayerType = batch.payerType;
    if (requestedPayerType) {
      payerResolutions = await Promise.all(
        batch.chargeItems.map(async (item) => {
          const resolved = await this.resolvePayers(item.unitId, requestedPayerType);
          return {
            chargeItemId: item.id,
            resolvedPayerType: resolved!.resolvedPayerType,
            personIds: resolved!.personIds,
          };
        }),
      );
    }

    const issued = await this.finance.issueChargeBatch({
      chargeBatchId,
      buildingId,
      fundId: batch.fundId,
      totalAmount: batch.totalAmount,
      actorId: actorPersonId,
      requestId,
      payerResolutions,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ChargeBatchIssued',
      entityType: 'ChargeBatch',
      entityId: chargeBatchId,
      requestId,
      metadata: { totalAmount: batch.totalAmount },
    });

    this.events.emit(
      'ChargeBatchIssued',
      new ChargeBatchIssuedEvent(chargeBatchId, buildingId, batch.totalAmount, actorPersonId),
    );

    return issued;
  }

  async cancelChargeBatch(
    buildingId: string,
    chargeBatchId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const batch = await this.getChargeBatch(buildingId, chargeBatchId);
    const hasAnyPaidAmount = await this.finance.hasAnyPaidChargeItems(chargeBatchId);
    this.chargePolicy.assertCancellable(batch.status, hasAnyPaidAmount);

    const cancelled = await this.finance.cancelChargeBatch(chargeBatchId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ChargeBatchCancelled',
      entityType: 'ChargeBatch',
      entityId: chargeBatchId,
      requestId,
    });

    this.events.emit(
      'ChargeBatchCancelled',
      new ChargeBatchCancelledEvent(chargeBatchId, buildingId, actorPersonId),
    );

    return cancelled;
  }

  private async getOwnUnit(buildingId: string, unitId: string) {
    const unit = await this.buildings.findUnitById(unitId);
    if (!unit || unit.buildingId !== buildingId) {
      throw new NotFoundAppError('Unit not found.');
    }
    return unit;
  }

  /** ADR-095 — each item's `lateFee` is computed live (never persisted) via `ChargePolicy.computeLateFeeEligibility`. */
  async listUnitChargeItems(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    const items = await this.finance.listChargeItemsByUnit(unitId);
    const appliedIds = await this.finance.findAppliedLateFeeChargeItemIds(items.map((i) => i.id));
    const now = new Date();

    return items.map((item) => {
      const result = this.chargePolicy.computeLateFeeEligibility({
        batchStatus: item.chargeBatch.status,
        lateFeeType: item.chargeBatch.lateFeeType,
        lateFeeValue: item.chargeBatch.lateFeeValue,
        lateFeeGraceDays: item.chargeBatch.lateFeeGraceDays,
        dueDate: item.chargeBatch.dueDate,
        now,
        itemAmount: item.amount,
        itemPaidAmount: item.paidAmount,
        alreadyApplied: appliedIds.has(item.id),
      });
      return {
        ...item,
        lateFee: result?.eligible ? { eligible: true as const, amount: result.amount } : null,
      };
    });
  }

  /**
   * ADR-095 — applies an eligible late fee as a real, ledger-backed
   * positive Adjustment (`sourceType: 'LATE_FEE'`, `sourceId:
   * chargeItemId`) — see Adjustment's own schema comment ("e.g. a one-off
   * late fee"); no new financial primitive was needed. Guards the
   * ChargeItem belongs to BOTH the requested building and unit before
   * anything else. Idempotent: a pre-check via `findAdjustmentBySource`
   * plus the DB-level `@@unique([sourceType, sourceId])` constraint (caught
   * here as a race-condition backstop) both prevent applying the same late
   * fee twice.
   */
  async applyLateFee(
    buildingId: string,
    unitId: string,
    chargeItemId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const item = await this.finance.findChargeItemById(chargeItemId);
    if (!item || item.unitId !== unitId || item.chargeBatch.buildingId !== buildingId) {
      throw new NotFoundAppError('Charge item not found.');
    }

    const alreadyApplied = !!(await this.finance.findAdjustmentBySource('LATE_FEE', chargeItemId));
    // ADR-095 correction 6 — re-applying a late fee to an item that already
    // has one is a DUPLICATE (409), a distinct, actionable case from the
    // general "not eligible" (422). This must be checked BEFORE consulting
    // policy eligibility below: computeLateFeeEligibility also treats
    // alreadyApplied as one of several reasons to return ineligible (it
    // needs that for the listUnitChargeItems/getUnitDebt aggregate views,
    // which scan many items at once with no room for per-item error
    // semantics) and would otherwise silently fold this case into the
    // generic 422 message.
    if (alreadyApplied) {
      throw new DuplicateError('A late fee has already been applied to this charge item.');
    }

    const eligibility = this.chargePolicy.computeLateFeeEligibility({
      batchStatus: item.chargeBatch.status,
      lateFeeType: item.chargeBatch.lateFeeType,
      lateFeeValue: item.chargeBatch.lateFeeValue,
      lateFeeGraceDays: item.chargeBatch.lateFeeGraceDays,
      dueDate: item.chargeBatch.dueDate,
      now: new Date(),
      itemAmount: item.amount,
      itemPaidAmount: item.paidAmount,
      alreadyApplied,
    });

    if (!eligibility?.eligible) {
      throw new BusinessRuleViolationError('This charge item is not eligible for a late fee.');
    }

    let adjustment;
    try {
      adjustment = await this.finance.createAdjustment({
        unitId,
        buildingId,
        fundId: item.chargeBatch.fundId,
        amount: eligibility.amount,
        reason: `Late fee — ${item.chargeBatch.title}`,
        createdById: actorPersonId,
        requestId,
        sourceType: 'LATE_FEE',
        sourceId: chargeItemId,
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new DuplicateError('A late fee has already been applied to this charge item.');
      }
      throw error;
    }

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'LateFeeApplied',
      entityType: 'Adjustment',
      entityId: adjustment.id,
      requestId,
      metadata: { unitId, chargeItemId, amount: eligibility.amount },
    });

    this.events.emit(
      'AdjustmentCreated',
      new AdjustmentCreatedEvent(adjustment.id, buildingId, unitId, eligibility.amount, actorPersonId),
    );

    return adjustment;
  }

  // --- Adjustments (08.05 Rule 014 — see 21_ADRs > ADR-037) -------------------

  async createAdjustment(
    buildingId: string,
    unitId: string,
    dto: CreateAdjustmentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);
    this.chargePolicy.assertValidAdjustmentAmount(dto.amount);

    const fund = dto.fundId
      ? await this.finance.findFundById(dto.fundId)
      : await this.finance.getOrCreateDefaultFund(buildingId);
    if (!fund || fund.buildingId !== buildingId) {
      throw new NotFoundAppError('Fund not found.');
    }

    const adjustment = await this.finance.createAdjustment({
      unitId,
      buildingId,
      fundId: fund.id,
      amount: dto.amount,
      reason: dto.reason,
      createdById: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'AdjustmentCreated',
      entityType: 'Adjustment',
      entityId: adjustment.id,
      requestId,
      reason: dto.reason,
      metadata: { unitId, amount: dto.amount },
    });

    this.events.emit(
      'AdjustmentCreated',
      new AdjustmentCreatedEvent(adjustment.id, buildingId, unitId, dto.amount, actorPersonId),
    );

    return adjustment;
  }

  async listUnitAdjustments(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    return this.finance.listAdjustmentsByUnit(unitId);
  }

  /** ADR-095 — `eligibleLateFeeTotal`/`eligibleLateFees` are computed, informational-only additions; the existing `chargeItemDebt`/`adjustmentDebt`/`totalDebt`/`creditBalance` shape is unchanged. */
  async getUnitDebt(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    const debt = await this.finance.getUnitDebt(unitId);

    const candidates = await this.finance.listLateFeeEligibleCandidates(unitId);
    const appliedIds = await this.finance.findAppliedLateFeeChargeItemIds(
      candidates.map((c) => c.id),
    );
    const now = new Date();

    const eligibleLateFees = candidates
      .map((c) => {
        const result = this.chargePolicy.computeLateFeeEligibility({
          batchStatus: c.chargeBatch.status,
          lateFeeType: c.chargeBatch.lateFeeType,
          lateFeeValue: c.chargeBatch.lateFeeValue,
          lateFeeGraceDays: c.chargeBatch.lateFeeGraceDays,
          dueDate: c.chargeBatch.dueDate,
          now,
          itemAmount: c.amount,
          itemPaidAmount: c.paidAmount,
          alreadyApplied: appliedIds.has(c.id),
        });
        return result?.eligible ? { chargeItemId: c.id, amount: result.amount } : null;
      })
      .filter((x): x is { chargeItemId: string; amount: number } => x !== null);

    return {
      ...debt,
      eligibleLateFeeTotal: eligibleLateFees.reduce((sum, f) => sum + f.amount, 0),
      eligibleLateFees,
    };
  }

  // --- Payments ----------------------------------------------------------------

  /**
   * Any current building member may report a payment for any unit — the
   * MVP does not check that the reporter is that unit's owner/tenant, only
   * that they belong to the building (route-level MembershipGuard). This
   * keeps "I paid, please confirm" friction-free (e.g. a family member
   * paying on an owner's behalf, or a manager entering cash collected in
   * person) at the cost of not restricting *who* can report; the real
   * gate is the ACCOUNTANT/MANAGER approval step below, where nothing
   * touches the ledger until a human with the right role confirms it.
   */
  async createPayment(
    buildingId: string,
    unitId: string,
    dto: CreatePaymentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);
    this.paymentPolicy.assertPositiveAmount(dto.amount);

    const fund = dto.fundId
      ? await this.finance.findFundById(dto.fundId)
      : await this.finance.getOrCreateDefaultFund(buildingId);
    if (!fund || fund.buildingId !== buildingId) {
      throw new NotFoundAppError('Fund not found.');
    }

    const payment = await this.finance.createPayment({
      buildingId,
      unitId,
      fundId: fund.id,
      payerId: actorPersonId,
      amount: dto.amount,
      method: dto.method,
      reference: dto.reference,
      note: dto.note,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'PaymentReported',
      entityType: 'Payment',
      entityId: payment.id,
      requestId,
      metadata: { unitId, amount: dto.amount, method: dto.method },
    });

    return payment;
  }

  listPayments(buildingId: string) {
    return this.finance.listPayments(buildingId);
  }

  async listUnitPayments(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    return this.finance.listPaymentsByUnit(unitId);
  }

  private async getOwnPayment(buildingId: string, paymentId: string) {
    const payment = await this.finance.findPaymentById(paymentId);
    if (!payment || payment.buildingId !== buildingId) {
      throw new NotFoundAppError('Payment not found.');
    }
    return payment;
  }

  async approvePayment(
    buildingId: string,
    paymentId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const payment = await this.getOwnPayment(buildingId, paymentId);
    this.paymentPolicy.assertPending(payment.status);

    const approved = await this.finance.approvePayment({
      paymentId,
      buildingId,
      unitId: payment.unitId,
      fundId: payment.fundId,
      amount: payment.amount,
      actorId: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'PaymentApproved',
      entityType: 'Payment',
      entityId: paymentId,
      requestId,
      metadata: { amount: payment.amount },
    });

    this.events.emit(
      'PaymentApproved',
      new PaymentApprovedEvent(
        paymentId,
        buildingId,
        payment.unitId,
        payment.amount,
        actorPersonId,
        payment.payerId,
      ),
    );

    return approved;
  }

  async rejectPayment(
    buildingId: string,
    paymentId: string,
    dto: RejectPaymentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const payment = await this.getOwnPayment(buildingId, paymentId);
    this.paymentPolicy.assertPending(payment.status);

    const rejected = await this.finance.rejectPayment(paymentId, dto.reason);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'PaymentRejected',
      entityType: 'Payment',
      entityId: paymentId,
      requestId,
      reason: dto.reason,
    });

    this.events.emit(
      'PaymentRejected',
      new PaymentRejectedEvent(paymentId, buildingId, payment.unitId, actorPersonId),
    );

    return rejected;
  }

  /** Undoes an erroneous/bounced/fraudulent APPROVED payment (08.06 Rule 010/014 — see 21_ADRs > ADR-037). */
  async reversePayment(
    buildingId: string,
    paymentId: string,
    dto: ReversePaymentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const payment = await this.getOwnPayment(buildingId, paymentId);
    this.paymentPolicy.assertReversible(payment.status);

    const reversed = await this.finance.reversePayment({
      paymentId,
      buildingId,
      fundId: payment.fundId,
      amount: payment.amount,
      actorId: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'PaymentReversed',
      entityType: 'Payment',
      entityId: paymentId,
      requestId,
      reason: dto.reason,
      metadata: { amount: payment.amount },
    });

    this.events.emit(
      'PaymentReversed',
      new PaymentReversedEvent(
        paymentId,
        buildingId,
        payment.unitId,
        payment.amount,
        actorPersonId,
      ),
    );

    return reversed;
  }

  /** Returns cash to the payer on a valid, already-APPROVED payment (08.06 Rules 010/013/015 — see 21_ADRs > ADR-037). */
  async refundPayment(
    buildingId: string,
    paymentId: string,
    dto: RefundPaymentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const payment = await this.getOwnPayment(buildingId, paymentId);
    const existingRefunds = await this.finance.findRefundsByPayment(paymentId);
    const refundAmount = dto.amount ?? payment.amount;
    this.paymentPolicy.assertRefundable(
      payment.status,
      refundAmount,
      payment.amount,
      existingRefunds.length > 0,
    );

    const refund = await this.finance.createRefund({
      paymentId,
      unitId: payment.unitId,
      buildingId,
      fundId: payment.fundId,
      amount: refundAmount,
      paymentAmount: payment.amount,
      reason: dto.reason,
      createdById: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'PaymentRefunded',
      entityType: 'Payment',
      entityId: paymentId,
      requestId,
      reason: dto.reason,
      metadata: { amount: refundAmount },
    });

    this.events.emit(
      'PaymentRefunded',
      new PaymentRefundedEvent(
        paymentId,
        buildingId,
        payment.unitId,
        refundAmount,
        actorPersonId,
        refundAmount >= payment.amount,
      ),
    );

    return refund;
  }

  async listPaymentRefunds(buildingId: string, paymentId: string) {
    await this.getOwnPayment(buildingId, paymentId);
    return this.finance.findRefundsByPayment(paymentId);
  }

  // --- Reporting -----------------------------------------------------------------

  async getFinancialSummary(buildingId: string) {
    await this.getBuilding(buildingId);
    return this.finance.getFinancialSummary(buildingId);
  }

  async listLedger(buildingId: string, fundId?: string) {
    await this.getBuilding(buildingId);
    return this.finance.listLedger(buildingId, fundId);
  }

  /** 21_ADRs > ADR-055 — `12_Finance_Architecture_v2.0`'s Collection Rate report, see `FinanceRepository.getCollectionRate` for exactly what's computed and how. */
  async getCollectionRate(buildingId: string, fromDate?: Date, toDate?: Date) {
    await this.getBuilding(buildingId);
    return this.finance.getCollectionRate(buildingId, fromDate, toDate);
  }

  /** 21_ADRs > ADR-057 — `02_MVP_Scope_v2.0`'s Payment Registration Rate metric, see `FinanceRepository.getPaymentRegistrationRate` for exactly what's computed and how. */
  async getPaymentRegistrationRate(buildingId: string, fromDate?: Date, toDate?: Date) {
    await this.getBuilding(buildingId);
    return this.finance.getPaymentRegistrationRate(buildingId, fromDate, toDate);
  }
}
