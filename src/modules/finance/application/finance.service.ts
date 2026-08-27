import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChargeKind, Prisma, PaymentStatus, ExpenseCategory, ExpenseStatus } from '@prisma/client';
import { FinanceRepository } from '../infrastructure/repositories/finance.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { ChargePolicy } from '../domain/policies/charge.policy';
import { PaymentPolicy } from '../domain/policies/payment.policy';
import { FundPolicy } from '../domain/policies/fund.policy';
import { CreateFundDto } from './dto/create-fund.dto';
import { UpdateFundDto } from './dto/update-fund.dto';
import { CreateChargeBatchDto } from './dto/create-charge-batch.dto';
import { CreateChargeSeriesDto } from './dto/create-charge-series.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CreateExplicitPaymentDto } from './dto/create-explicit-payment.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CorrectOpeningBalanceDto } from './dto/correct-opening-balance.dto';
import { ReversePaymentDto } from './dto/reverse-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { VoidExpenseDto } from './dto/void-expense.dto';
import { ExpensePolicy } from '../domain/policies/expense.policy';
import {
  ChargeFundAlignmentPolicy,
  NEW_CHARGE_KIND_ORDER,
} from '../domain/policies/charge-fund-alignment.policy';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ChargeFundSelectionRequiredError,
  ConflictError,
  DuplicateError,
  NotFoundAppError,
} from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';

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
import { ExpenseCreatedEvent, ExpenseVoidedEvent } from '../events/expense.events';

/**
 * FIN-CALC-01 — deterministic EQUAL allocation of `totalAmount` (integer
 * Rial) across `unitIds` (the batch's already-scope-filtered eligible
 * units), guaranteeing `SUM(item.amount) === totalAmount` exactly, with
 * no independent per-item rounding drift.
 *
 * `base = floor(totalAmount / n)`; the remainder (`totalAmount - base *
 * n`, always an integer in `[0, n)`) is handed out one extra Rial at a
 * time to the FIRST `remainder` units in `unitIds`'s own order — the same
 * order `FinanceService.filterUnitsByScope` already returns (itself the
 * underlying `BuildingRepository.listUnits` read, unchanged by this
 * task). Because `previewChargeBatch` and `createChargeBatch` both reach
 * this through the identical `resolveChargeItems` path against the same
 * repository read, they always agree exactly — the remainder is never
 * assigned differently between a preview and the batch it becomes.
 *
 * A `totalAmount` smaller than `unitIds.length` is allowed and produces
 * some `amount: 0` items (base is 0, only `remainder` units get 1 Rial) —
 * deliberate, not a bug: `ChargePolicy.assertValidCalculationInputs`
 * already guarantees `totalAmount > 0`, and a zero-amount ChargeItem is a
 * harmless, already-UNPAID-by-default row (Finance-hardening's
 * `computeItemStatus`/credit-balance-application paths treat a
 * zero-outstanding item as a no-op, never a crash).
 */
function allocateEqually(
  totalAmount: number,
  unitIds: string[],
): Array<{ unitId: string; amount: number }> {
  const n = unitIds.length;
  const base = Math.floor(totalAmount / n);
  const remainder = totalAmount - base * n;
  return unitIds.map((unitId, index) => ({
    unitId,
    amount: index < remainder ? base + 1 : base,
  }));
}

/**
 * FIN-CALC-01 — deterministic AREA-PROPORTIONAL allocation of
 * `totalAmount` across `units` (the batch's scope-filtered units that
 * additionally have a positive `areaSqm` — see `resolveChargeItems`'s
 * AREA_BASED branch for why area-less units never reach this function),
 * using the largest-remainder ("Hamilton apportionment") method so
 * `SUM(item.amount) === totalAmount` exactly.
 *
 * Each unit's exact share is `totalAmount * unitArea / totalArea` (a
 * real number). Flooring every share independently and summing the
 * floors would under-allocate by the sum of the dropped fractions —
 * breaking the required SUM invariant — so instead: floor every share
 * first, then hand the leftover Rials (`totalAmount - sum(floors)`,
 * always an integer in `[0, units.length)`) out one at a time to the
 * units whose fractional remainder was largest. Ties (equal fractional
 * remainder) are broken by the unit's own original position in `units` —
 * the same stable order `filterUnitsByScope` already returns — so this
 * is fully deterministic. As with `allocateEqually`, `previewChargeBatch`
 * and `createChargeBatch`/`issueChargeBatch` share the identical
 * `resolveChargeItems` call and the same repository read, so preview and
 * the real batch always agree exactly.
 */
function allocateByArea(
  totalAmount: number,
  units: Array<{ unitId: string; areaSqm: number }>,
): Array<{ unitId: string; amount: number }> {
  const totalArea = units.reduce((sum, u) => sum + u.areaSqm, 0);
  const shares = units.map((u, index) => {
    const exact = (totalAmount * u.areaSqm) / totalArea;
    const floorAmount = Math.floor(exact);
    return { unitId: u.unitId, index, floorAmount, fraction: exact - floorAmount };
  });
  const allocated = shares.reduce((sum, s) => sum + s.floorAmount, 0);
  const leftover = totalAmount - allocated;

  const byRemainderDesc = [...shares].sort((a, b) => {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    // Deterministic tie-break: the unit's own stable original position.
    return a.index - b.index;
  });
  const bonusUnitIds = new Set(byRemainderDesc.slice(0, leftover).map((s) => s.unitId));

  return shares.map((s) => ({
    unitId: s.unitId,
    amount: s.floorAmount + (bonusUnitIds.has(s.unitId) ? 1 : 0),
  }));
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly buildings: BuildingRepository,
    private readonly chargePolicy: ChargePolicy,
    private readonly paymentPolicy: PaymentPolicy,
    private readonly fundPolicy: FundPolicy,
    private readonly expensePolicy: ExpensePolicy,
    private readonly chargeFundAlignment: ChargeFundAlignmentPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  /**
   * Finance Hardening Pass (post-audit) — resolves the target Fund for any
   * WRITE path (explicit `dto.fundId`, or the building's default fund when
   * omitted) and asserts it's active before the caller uses it.
   *
   * Root cause this fixes: `createChargeBatch`/`createPayment`/
   * `createAdjustment` previously fetched the fund via this exact
   * `dto.fundId ?? getOrCreateDefaultFund` pattern inline, checked only
   * "does it exist and belong to this building," and never consulted
   * `fund.isActive` — contradicting `Fund`'s own schema comment ("a
   * deactivated fund ... can't receive new Charge Batches or Payments
   * going forward") and `FundPolicy.assertActive`'s only prior call site
   * (`updateFund`). Centralizing the resolve+validate step here means
   * every write path enforces the same invariant the same way, whether
   * the fund came from an explicit id or default-fund resolution — a
   * newly-created default fund is always active by construction
   * (`getOrCreateDefaultFund`/`FundPolicy.assertDeactivatable` both keep
   * it that way), so this is a no-op for the common case and only ever
   * bites when a caller deliberately targets a deactivated fund by id.
   */
  private async resolveFundForWrite(buildingId: string, fundId: string | undefined) {
    const fund = fundId
      ? await this.finance.findFundById(fundId)
      : await this.finance.getOrCreateDefaultFund(buildingId);
    if (!fund || fund.buildingId !== buildingId) {
      throw new NotFoundAppError('Fund not found.');
    }
    this.fundPolicy.assertActive(fund.isActive);
    return fund;
  }

  private async resolveChargeFund(
    buildingId: string,
    dto: CreateChargeBatchDto,
    mode: 'preview' | 'create',
  ) {
    if (!dto.chargeKind) {
      if (mode === 'create') {
        return {
          fund: await this.resolveFundForWrite(buildingId, dto.fundId),
          willCreateDefaultFund: false,
        };
      }
      if (dto.fundId) {
        const fund = await this.finance.findFundById(dto.fundId);
        if (!fund || fund.buildingId !== buildingId) throw new NotFoundAppError('Fund not found.');
        this.fundPolicy.assertActive(fund.isActive);
        return { fund, willCreateDefaultFund: false };
      }
      const fund = await this.finance.findDefaultFund(buildingId);
      if (fund) this.fundPolicy.assertActive(fund.isActive);
      return { fund, willCreateDefaultFund: fund === null };
    }

    const chargeKind = dto.chargeKind as ChargeKind;
    this.chargeFundAlignment.assertSupportedForNewCreation(chargeKind);
    if (dto.fundId) {
      const fund = await this.finance.findFundById(dto.fundId);
      if (!fund || fund.buildingId !== buildingId) throw new NotFoundAppError('Fund not found.');
      this.fundPolicy.assertActive(fund.isActive);
      this.chargeFundAlignment.assertFundCompatible(chargeKind, fund.type);
      return { fund, willCreateDefaultFund: false };
    }

    const compatibleFunds = (await this.finance.listActiveChargeOptionFunds(buildingId)).filter(
      (fund) => this.chargeFundAlignment.isFundCompatible(chargeKind, fund.type),
    );
    if (compatibleFunds.length !== 1) {
      throw new ChargeFundSelectionRequiredError(
        compatibleFunds.length === 0
          ? 'No active compatible fund exists for this charge type.'
          : 'Multiple active compatible funds exist; fundId is required.',
        {
          reason: compatibleFunds.length === 0 ? 'NO_COMPATIBLE_FUND' : 'AMBIGUOUS_COMPATIBLE_FUND',
          chargeKind,
        },
      );
    }
    return { fund: compatibleFunds[0], willCreateDefaultFund: false };
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

  /** Finance Hardening Pass — paginated (ADR-072 convention), see `FinanceRepository.listFunds`'s own doc comment. */
  async listFunds(buildingId: string, pagination: PaginationParams) {
    const { items, total } = await this.finance.listFunds(buildingId, toSkipTake(pagination));
    return { items, meta: buildPaginationMeta(pagination, total) };
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
    // FIN-CALC-01 — count of in-scope AREA_BASED units excluded because
    // they have no positive `areaSqm`, purely for `previewChargeBatch`'s
    // `validationWarnings` visibility (see that method). Always 0 for
    // FIXED/MIXED. `createChargeBatch` ignores this field entirely — it
    // doesn't change persistence, only what preview surfaces to the
    // caller before they issue.
    areaUnitsSkippedForMissingArea: number;
  }> {
    this.chargePolicy.assertValidCalculationInputs(dto.calculationMethod, dto);

    if (dto.calculationMethod === 'MIXED') {
      return {
        items: dto.items!.map((i) => ({ unitId: i.unitId, amount: i.amount })),
        effectiveUnitScope: null,
        areaUnitsSkippedForMissingArea: 0,
      };
    }

    const allUnits = await this.buildings.listUnits(buildingId);
    const effectiveUnitScope = dto.unitScope ?? 'ALL';
    const units = this.filterUnitsByScope(allUnits, effectiveUnitScope, dto.unitIds);

    if (dto.calculationMethod === 'FIXED') {
      if (dto.totalAmount !== undefined) {
        // FIN-CALC-01 — the manager's chosen total, split evenly across
        // every eligible unit (see `allocateEqually`'s own doc comment).
        return {
          items: allocateEqually(
            dto.totalAmount,
            units.map((u) => u.id),
          ),
          effectiveUnitScope,
          areaUnitsSkippedForMissingArea: 0,
        };
      }
      // Legacy — amountPerUnit applied verbatim to every eligible unit,
      // UNCHANGED from before FIN-CALC-01 (kept only for the
      // currently-shipped Mobile client — see
      // CreateChargeBatchDto.amountPerUnit's own doc comment).
      return {
        items: units.map((u) => ({ unitId: u.id, amount: dto.amountPerUnit! })),
        effectiveUnitScope,
        areaUnitsSkippedForMissingArea: 0,
      };
    }

    // AREA_BASED — units with no areaSqm configured yet are skipped rather
    // than charged 0 (06_User_Flows: area is a "Configure Units" follow-up,
    // not guaranteed at skeleton-unit creation time). Identical rule under
    // both the new totalAmount shape and the legacy ratePerSqm shape.
    const unitsWithArea = units.filter((u) => u.areaSqm && u.areaSqm > 0);
    const areaUnitsSkippedForMissingArea = units.length - unitsWithArea.length;

    if (dto.totalAmount !== undefined) {
      // FIN-CALC-01 — AREA VALIDATION: a totalAmount-based AREA_BASED
      // batch cannot proportionally divide anything if not one in-scope
      // unit has a usable area — that's a data-integrity problem the
      // caller must fix (add area to at least one unit, or narrow scope),
      // not something to paper over with an invented fallback (e.g.
      // splitting evenly instead — no evidence that's what the product
      // wants when AREA_BASED was explicitly requested). This is
      // deliberately stricter than the legacy ratePerSqm shape below,
      // which silently produces zero items in this same situation
      // (pre-existing, unchanged, since altering that would risk the
      // currently-shipped Mobile client's behavior) — the new shape has
      // no such compatibility constraint, so it fails loudly instead.
      if (unitsWithArea.length === 0) {
        throw new BusinessRuleViolationError(
          `An AREA_BASED charge batch requires at least one in-scope unit with a positive area configured; 0 of ${units.length} in-scope unit(s) have area set.`,
        );
      }
      return {
        items: allocateByArea(
          dto.totalAmount,
          unitsWithArea.map((u) => ({ unitId: u.id, areaSqm: u.areaSqm as number })),
        ),
        effectiveUnitScope,
        areaUnitsSkippedForMissingArea,
      };
    }

    // Legacy — per-unit rate, UNCHANGED from before FIN-CALC-01.
    return {
      items: unitsWithArea.map((u) => ({
        unitId: u.id,
        amount: Math.round(dto.ratePerSqm! * (u.areaSqm as number)),
      })),
      effectiveUnitScope,
      areaUnitsSkippedForMissingArea,
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
   * ADR-095 / FIN-CTX-01 — resolves who a unit's charge is attributed to
   * (informational only, see ChargeBatch.payerType's own comment).
   * RESIDENT (and its deprecated legacy alias TENANT — see
   * ChargePayerType's own comment) falls back to OWNER when the unit has
   * no active Tenancy — snapshotting ALL current owners, never picking
   * one arbitrarily, since this schema has never enforced
   * single-ownership-per-unit (see `Ownership`'s own schema comment).
   *
   * This IS the correct RESIDENT resolution, not a stand-in for one: this
   * schema has no reliable way to positively confirm "the owner
   * physically occupies this unit" (`Unit.occupancyStatus`'s
   * OWNER_OCCUPIED value is a free-standing manual flag a manager can set
   * via `updateUnit`, never reconciled against Ownership/Tenancy — see
   * that field's own schema comment) — but it doesn't need to, because
   * the payer is the same person (the current owner) whether the unit is
   * genuinely vacant or the owner lives there themselves. Only "does an
   * active Tenancy exist" needs to be known to resolve RESIDENT correctly,
   * and that IS reliably tracked (`Tenancy.isCurrent`, kept in sync by
   * `createTenancy`/`endTenancy`).
   *
   * New resolutions never write `'TENANT'` — only `'OWNER'` or
   * `'RESIDENT'` — regardless of whether the caller requested `RESIDENT`
   * or the legacy `TENANT` alias, so `ChargeItem.resolvedPayerType` never
   * grows new TENANT rows after FIN-CTX-01.
   *
   * Shared verbatim by `previewChargeBatch` (display-only) and
   * `issueChargeBatch` (persisted snapshot) — same function, so the two
   * can only ever differ because the underlying ownership/tenancy data
   * changed between calls, never because the resolution logic differs.
   */
  private async resolvePayers(
    unitId: string,
    payerType: CreateChargeBatchDto['payerType'],
  ): Promise<{ resolvedPayerType: 'OWNER' | 'RESIDENT'; personIds: string[] } | null> {
    if (!payerType) return null;

    if (payerType === 'RESIDENT' || payerType === 'TENANT') {
      const tenancy = await this.buildings.findCurrentTenancyForUnit(unitId);
      if (tenancy) {
        return { resolvedPayerType: 'RESIDENT', personIds: [tenancy.personId] };
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

    await this.resolveChargeClassification(buildingId, dto);

    const { fund: resolvedFund } = await this.resolveChargeFund(buildingId, dto, 'create');
    // Create-mode legacy resolution creates a default when needed, while
    // classified resolution either returns one exact fund or throws.
    const fund = resolvedFund!;

    const { items, effectiveUnitScope } = await this.resolveChargeItems(buildingId, dto);

    let batch;
    try {
      batch = await this.finance.createChargeBatch({
        buildingId,
        fundId: fund.id,
        title: dto.title,
        description: dto.description,
        calculationMethod: dto.calculationMethod,
        kind: dto.chargeKind,
        expectedFundType: dto.chargeKind ? fund.type : undefined,
        seriesId: dto.seriesId,
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
    } catch (error) {
      if (isUniqueConstraintViolation(error) && dto.chargeKind === 'MONTHLY') {
        throw new DuplicateError('This charge series already has a charge for this period.');
      }
      throw error;
    }

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
    const series = await this.resolveChargeClassification(buildingId, dto);

    const { fund: resolvedFund, willCreateDefaultFund } = await this.resolveChargeFund(
      buildingId,
      dto,
      'preview',
    );
    const fund = resolvedFund ? { id: resolvedFund.id, name: resolvedFund.name } : null;

    const { items, effectiveUnitScope, areaUnitsSkippedForMissingArea } =
      await this.resolveChargeItems(buildingId, dto);
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
      validationWarnings.push(
        'No units matched the requested scope — this batch would have zero items.',
      );
    }
    // FIN-CALC-01 — AREA VALIDATION: surfaces the pre-existing "units
    // with no area are skipped, not charged 0" behavior (unchanged by
    // this task — see resolveChargeItems's AREA_BASED branch) explicitly
    // to the caller instead of leaving it silent, for both the new
    // totalAmount shape and the legacy ratePerSqm shape alike.
    if (areaUnitsSkippedForMissingArea > 0) {
      validationWarnings.push(
        `${areaUnitsSkippedForMissingArea} unit(s) in scope were skipped because they have no positive area configured.`,
      );
    }

    return {
      chargeKind: dto.chargeKind ?? null,
      series: series ? { id: series.id, name: series.name } : null,
      periodStart: dto.periodStart ?? null,
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

  /** Finance Hardening Pass — paginated, see `FinanceRepository.listFunds`'s own doc comment. */
  async listChargeBatches(buildingId: string, pagination: PaginationParams) {
    const { items, total } = await this.finance.listChargeBatches(
      buildingId,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
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
      resolvedPayerType: 'OWNER' | 'RESIDENT';
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

  /**
   * ADR-095 — each item's `lateFee` is computed live (never persisted) via
   * `ChargePolicy.computeLateFeeEligibility`. Finance Hardening Pass —
   * paginated (see `FinanceRepository.listFunds`'s own doc comment); the
   * late-fee computation runs only over the current page's items, same as
   * every other per-item derivation in this method already did per item.
   */
  async listUnitChargeItems(buildingId: string, unitId: string, pagination: PaginationParams) {
    await this.getOwnUnit(buildingId, unitId);
    const { items, total } = await this.finance.listChargeItemsByUnit(
      unitId,
      toSkipTake(pagination),
    );
    const appliedIds = await this.finance.findAppliedLateFeeChargeItemIds(items.map((i) => i.id));
    const now = new Date();

    const withLateFee = items.map((item) => {
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

    return { items: withLateFee, meta: buildPaginationMeta(pagination, total) };
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
      new AdjustmentCreatedEvent(
        adjustment.id,
        buildingId,
        unitId,
        eligibility.amount,
        actorPersonId,
      ),
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

    const fund = await this.resolveFundForWrite(buildingId, dto.fundId);

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

  /**
   * Finance Correction Pass — read-side companion to `correctOpeningBalance`
   * below. Any current member may read it (same `MembershipGuard` tier as
   * `getUnitDebt`) — only the correction *write* is role-gated.
   */
  async getUnitOpeningBalance(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    const effectiveOpeningBalance = await this.finance.getUnitOpeningBalanceCorrectionTotal(unitId);
    return { effectiveOpeningBalance };
  }

  /**
   * Finance Correction Pass — corrects a unit's *effective opening balance*
   * (its initial debt/credit, independent of regular ChargeBatch/Payment
   * activity since) without ever overwriting a historical ledger/Adjustment/
   * ChargeItem row. There is no dedicated "opening balance" field anywhere
   * on `Unit` — only `Fund` has one (`Fund.initialBalance` /
   * `OPENING_BALANCE` ledger entries). This method defines a Unit's
   * *effective opening balance* as the running sum of every Adjustment ever
   * recorded against it with `sourceType: 'OPENING_BALANCE_CORRECTION'`
   * (see `FinanceRepository.getUnitOpeningBalanceCorrectionTotal`) —
   * mirroring the Fund convention instead of inventing a new one.
   *
   * Each correction is itself just another signed Adjustment for the
   * *delta* between the requested `targetBalance` and the unit's current
   * effective opening balance, created via
   * `FinanceRepository.applyOpeningBalanceCorrection` — a dedicated method,
   * not `createAdjustment`, because `createAdjustment`'s own waiver
   * semantics (ChargeItem-only, excess silently discarded, never creates
   * credit) are wrong for this feature: they'd let a downward correction
   * bleed into unrelated regular monthly charges, and would silently drop
   * any correction amount deep enough to represent a real unit credit. See
   * `applyOpeningBalanceCorrection`'s own doc comment for the full waterfall
   * (prior opening-balance corrections, oldest first, then `CreditBalance`)
   * this uses instead. Every correction still gets its own immutable
   * Adjustment + LedgerEntry + AuditLog row — nothing is ever overwritten —
   * and the unit's aggregate debt/credit (`FinanceService.getUnitDebt`)
   * stays mathematically correct because it is always computed live from
   * those rows, never cached. The same `AdjustmentCreatedEvent` (already
   * wired to `NotificationEventListener`) still fires either way.
   *
   * Authorization: `ACCOUNTANT` and `MANAGER` — the identical
   * `@Roles('ACCOUNTANT', 'MANAGER')` gate as `createAdjustment`/
   * `applyLateFee` (both are financial corrections with the same
   * real-money consequence). `RolesGuard` unions a caller's own roles
   * (OR-based — see its own doc comment): an Accountant existing on the
   * building never revokes the Manager's own authority, and vice versa.
   */
  async correctOpeningBalance(
    buildingId: string,
    unitId: string,
    dto: CorrectOpeningBalanceDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getOwnUnit(buildingId, unitId);

    const previousBalance = await this.finance.getUnitOpeningBalanceCorrectionTotal(unitId);
    const delta = dto.targetBalance - previousBalance;
    if (delta === 0) {
      throw new BusinessRuleViolationError(
        "The requested opening balance matches the unit's current effective opening balance; no correction is needed.",
      );
    }

    const fund = await this.resolveFundForWrite(buildingId, dto.fundId);

    const adjustment = await this.finance.applyOpeningBalanceCorrection({
      unitId,
      buildingId,
      fundId: fund.id,
      amount: delta,
      reason: dto.reason,
      createdById: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'UnitOpeningBalanceCorrected',
      entityType: 'Adjustment',
      entityId: adjustment.id,
      requestId,
      reason: dto.reason,
      metadata: {
        unitId,
        previousBalance,
        newBalance: dto.targetBalance,
        delta,
      },
    });

    this.events.emit(
      'AdjustmentCreated',
      new AdjustmentCreatedEvent(adjustment.id, buildingId, unitId, delta, actorPersonId),
    );

    return { adjustment, previousBalance, newBalance: dto.targetBalance, delta };
  }

  /** Finance Hardening Pass — paginated, see `FinanceRepository.listFunds`'s own doc comment. */
  async listUnitAdjustments(buildingId: string, unitId: string, pagination: PaginationParams) {
    await this.getOwnUnit(buildingId, unitId);
    const { items, total } = await this.finance.listAdjustmentsByUnit(
      unitId,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
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

  async listUnitDebtSummaries(buildingId: string, pagination: PaginationParams) {
    await this.getBuilding(buildingId);
    const { items, total } = await this.finance.listUnitDebtSummaries(
      buildingId,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
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
   *
   * Finance QA correction (physical-device duplicate-payment bug, 2026-08)
   * — `FinanceRepository.createPayment` now validates `dto.amount` against
   * the unit's current *remaining payable* (confirmed debt minus whatever
   * is already PENDING_APPROVAL) unless `dto.isManualAmount` is set, and
   * does so atomically per-unit so two near-simultaneous reports can't
   * both slip past the same stale figure — see that method's own doc
   * comment for the full model and the concurrency mechanism.
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

    const fund = await this.resolveFundForWrite(buildingId, dto.fundId);

    const payment = await this.finance.createPayment({
      buildingId,
      unitId,
      fundId: fund.id,
      payerId: actorPersonId,
      amount: dto.amount,
      method: dto.method,
      reference: dto.reference,
      note: dto.note,
      isManualAmount: dto.isManualAmount ?? false,
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

  private async assertCanPayExactUnit(
    buildingId: string,
    unitId: string,
    personId: string,
  ): Promise<void> {
    await this.getOwnUnit(buildingId, unitId);
    const [roles, isOwner, tenancy] = await Promise.all([
      this.buildings.getRoles(personId, buildingId),
      this.buildings.isCurrentOwnerOfUnit(unitId, personId),
      this.buildings.findCurrentTenancyForUnit(unitId),
    ]);
    if (roles.includes('MANAGER') || isOwner || tenancy?.personId === personId) return;
    throw new AuthorizationError('You do not have payment authority for this unit.');
  }

  private parseExplicitObligations(obligationIds: string[]) {
    if (new Set(obligationIds).size !== obligationIds.length) {
      throw new DuplicateError('Duplicate obligation identifiers are not allowed.');
    }
    return obligationIds.map((obligationId) => {
      const separator = obligationId.indexOf(':');
      const type = obligationId.slice(0, separator);
      const id = obligationId.slice(separator + 1);
      if (separator <= 0 || !id || (type !== 'CHARGE_ITEM' && type !== 'ADJUSTMENT')) {
        throw new BusinessRuleViolationError('Invalid obligation identifier.');
      }
      return { type, id } as
        { type: 'CHARGE_ITEM'; id: string } | { type: 'ADJUSTMENT'; id: string };
    });
  }

  async getSelectableObligations(buildingId: string, unitId: string, actorPersonId: string) {
    await this.assertCanPayExactUnit(buildingId, unitId, actorPersonId);
    return this.finance.listSelectableObligations(unitId);
  }

  async createExplicitPayment(
    buildingId: string,
    unitId: string,
    dto: CreateExplicitPaymentDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.assertCanPayExactUnit(buildingId, unitId, actorPersonId);
    const targets = this.parseExplicitObligations(dto.obligationIds);
    try {
      const payment = await this.finance.createExplicitPayment({
        buildingId,
        unitId,
        payerId: actorPersonId,
        method: dto.method,
        idempotencyKey: dto.idempotencyKey,
        reference: dto.reference,
        note: dto.note,
        targets,
      });
      await this.audit.record({
        actorId: actorPersonId,
        buildingId,
        action: 'ExplicitPaymentReported',
        entityType: 'Payment',
        entityId: payment.id,
        requestId,
        metadata: { unitId, amount: payment.amount, obligationCount: targets.length },
      });
      return payment;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError('One or more obligations are already reserved.');
      }
      throw error;
    }
  }

  /** Finance Hardening Pass — paginated, see `FinanceRepository.listFunds`'s own doc comment. */
  /** Backend ↔ Mobile Contract Alignment — optional `status` filter, see `FinanceController.listPayments`'s own doc comment for the full rationale. */
  async listPayments(buildingId: string, pagination: PaginationParams, status?: PaymentStatus) {
    const { items, total } = await this.finance.listPayments(
      buildingId,
      toSkipTake(pagination),
      status,
    );
    // FIN-REC-01B — hasReceipt/receipt enrichment, see `attachReceiptMetadata`'s own doc comment.
    const enriched = await this.attachReceiptMetadata(items);
    return { items: enriched, meta: buildPaginationMeta(pagination, total) };
  }

  /** Finance Hardening Pass — paginated, see `FinanceRepository.listFunds`'s own doc comment. */
  async listUnitPayments(buildingId: string, unitId: string, pagination: PaginationParams) {
    await this.getOwnUnit(buildingId, unitId);
    const { items, total } = await this.finance.listPaymentsByUnit(unitId, toSkipTake(pagination));
    // FIN-REC-01B — hasReceipt/receipt enrichment, see `attachReceiptMetadata`'s own doc comment.
    const enriched = await this.attachReceiptMetadata(items);
    return { items: enriched, meta: buildPaginationMeta(pagination, total) };
  }

  /**
   * Public (FIN-REC-01B) — `PaymentReceiptService` and
   * `DocumentsService.assertPaymentReferenceAccess` both need the exact
   * same "does this paymentId really belong to this building" re-check
   * `approvePayment`/`rejectPayment` already rely on (see the class doc
   * comment's Authorization mapping and 21_ADRs > ADR-022's
   * "role-on-URL-building PLUS service-level re-check" pattern) — kept as
   * one method, not duplicated, so every caller gets the identical
   * not-found semantics.
   */
  async getOwnPayment(buildingId: string, paymentId: string) {
    const payment = await this.finance.findPaymentById(paymentId);
    if (!payment || payment.buildingId !== buildingId) {
      throw new NotFoundAppError('Payment not found.');
    }
    return payment;
  }

  /**
   * FIN-REC-01B — the exact "payer or finance reviewer of this Payment's
   * own building" authorization rule, shared by the payment-receipt
   * endpoints (`PaymentReceiptService`) and Documents' PAYMENT-reference
   * inherited-access check (`DocumentsService.assertPaymentReferenceAccess`).
   * "The payer" means exactly `Payment.payerId === actorPersonId` (see
   * `createPayment`/`createExplicitPayment`'s own doc comments — the payer
   * may be a manager acting on someone's behalf, not necessarily the real
   * money-payer); "finance reviewer" means exactly the same
   * `MANAGER`/`ACCOUNTANT`-on-this-building check `RolesGuard` +
   * `getOwnPayment` already enforce for approve/reject, re-derived from
   * `payment.buildingId` (never the caller's URL segment alone) — never
   * broadened to OWNER/TENANT/BOARD_MEMBER, and never satisfied by a
   * MANAGER/ACCOUNTANT of a different building.
   */
  async getPaymentForViewer(buildingId: string, paymentId: string, actorPersonId: string) {
    const payment = await this.getOwnPayment(buildingId, paymentId);
    if (payment.payerId !== actorPersonId) {
      const roles = await this.buildings.getRoles(actorPersonId, payment.buildingId);
      const isFinanceReviewer = roles.includes('MANAGER') || roles.includes('ACCOUNTANT');
      if (!isFinanceReviewer) {
        throw new AuthorizationError(
          'Only the payer or a Manager/Accountant of this building may access this payment receipt.',
        );
      }
    }
    return payment;
  }

  /**
   * FIN-REC-01B — batched `hasReceipt`/`receipt` enrichment for
   * `listPayments`/`listUnitPayments`. There are no dedicated Payment
   * response DTOs in this codebase (raw Prisma rows are returned as-is —
   * see those methods' own doc comments), so this attaches the two new
   * fields onto the existing raw row rather than introducing a full
   * DTO/mapper layer that doesn't exist today. Never attaches
   * `storageKey`/bucket/path/URL — only the compact metadata a client
   * needs to know a receipt exists and show its filename/size/date.
   */
  private async attachReceiptMetadata<T extends { id: string }>(
    items: T[],
  ): Promise<
    Array<
      T & {
        hasReceipt: boolean;
        receipt: {
          id: string;
          filename: string;
          contentType: string;
          size: number;
          createdAt: Date;
        } | null;
      }
    >
  > {
    if (items.length === 0) return [];
    const references = await this.finance.listPaymentReceiptsByPaymentIds(
      items.map((item) => item.id),
    );
    const referenceByPaymentId = new Map(
      references.map((reference) => [reference.entityId, reference]),
    );
    return items.map((item) => {
      const reference = referenceByPaymentId.get(item.id);
      return {
        ...item,
        hasReceipt: Boolean(reference),
        receipt: reference
          ? {
              id: reference.documentVersion.documentId,
              filename: reference.documentVersion.fileName,
              contentType: reference.documentVersion.fileType,
              size: reference.documentVersion.fileSize,
              createdAt: reference.documentVersion.uploadedAt,
            }
          : null,
      };
    });
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

  /**
   * Undoes an erroneous/bounced/fraudulent APPROVED payment (08.06 Rule
   * 010/014 — see 21_ADRs > ADR-037).
   *
   * 21_ADRs > ADR-113 — `options.auditAction` lets a second caller (the
   * Backoffice Financial Administration endpoint, gated by
   * `FINANCE_REFUND` rather than a building membership role) reuse this
   * exact method — same policy check, same repository mutation, same
   * event emission (so payer notification/gamification effects fire
   * identically regardless of who initiated the reversal) — while still
   * recording a distinctly-named audit action
   * (`PaymentReversedByAdmin`) so the Audit Center can always tell a
   * staff-direct override apart from this in-building workflow's own
   * `PaymentReversed`. Omitting it (every existing call site) preserves
   * the exact pre-ADR-113 behavior.
   */
  async reversePayment(
    buildingId: string,
    paymentId: string,
    dto: ReversePaymentDto,
    actorPersonId: string,
    requestId: string,
    options?: { auditAction?: string },
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
      action: options?.auditAction ?? 'PaymentReversed',
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

  /**
   * Returns cash to the payer on a valid, already-APPROVED payment (08.06
   * Rules 010/013/015 — see 21_ADRs > ADR-037).
   *
   * 21_ADRs > ADR-113 — `options.auditAction`, same reuse-with-a-
   * distinct-audit-name shape as `reversePayment` above.
   */
  async refundPayment(
    buildingId: string,
    paymentId: string,
    dto: RefundPaymentDto,
    actorPersonId: string,
    requestId: string,
    options?: { auditAction?: string },
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
      action: options?.auditAction ?? 'PaymentRefunded',
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

  /** Finance Hardening Pass — paginated, see `FinanceRepository.listFunds`'s own doc comment. In practice bounded to 0–1 rows per payment (one refund per payment this MVP — see the `Refund` model's own schema comment), but added for consistency with every other Finance list route. */
  async listPaymentRefunds(buildingId: string, paymentId: string, pagination: PaginationParams) {
    await this.getOwnPayment(buildingId, paymentId);
    const { items, total } = await this.finance.listRefundsByPayment(
      paymentId,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  // --- Expenses / Disbursements (FIN-EXP-01/FIN-EXP-02 -- see 21_ADRs > ADR-126) ---

  private async getOwnExpense(buildingId: string, expenseId: string) {
    const expense = await this.finance.findExpenseById(expenseId);
    if (!expense || expense.buildingId !== buildingId) {
      throw new NotFoundAppError('Expense not found.');
    }
    return expense;
  }

  /**
   * Records money the building SPENT (FIN-EXP-01 design doc). RolesGuard
   * already enforced MANAGER|ACCOUNTANT before this method runs -- no
   * in-method role re-check needed, same as `createAdjustment`.
   * `ExpensePolicy.assertSufficientFundBalance` here is the fast, friendly
   * pre-check for the common (non-racy) case; `FinanceRepository.
   * createExpense`'s own re-read of `fund.balance` inside its transaction
   * is the authoritative check for a concurrent write shrinking the
   * balance in the gap between this pre-check and that transaction (same
   * split `resolveFundForWrite`'s callers already rely on for
   * `FundPolicy.assertActive`).
   */
  async createExpense(
    buildingId: string,
    dto: CreateExpenseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);
    this.expensePolicy.assertValidAmount(dto.amount);

    const fund = await this.resolveFundForWrite(buildingId, dto.fundId);
    this.expensePolicy.assertSufficientFundBalance(fund.balance, dto.amount);

    let expense;
    try {
      expense = await this.finance.createExpense({
        buildingId,
        fundId: fund.id,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        amount: dto.amount,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        createdById: actorPersonId,
        idempotencyKey: dto.idempotencyKey,
        requestId,
      });
    } catch (error) {
      // A genuine retry of the same request (same idempotencyKey) -- return
      // the original Expense instead of raising, same
      // isUniqueConstraintViolation pattern `applyLateFee` already uses for
      // Adjustment's sourceType/sourceId race.
      if (dto.idempotencyKey && isUniqueConstraintViolation(error)) {
        const existing = await this.finance.findExpenseByIdempotencyKey(dto.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ExpenseCreated',
      entityType: 'Expense',
      entityId: expense.id,
      requestId,
      metadata: { fundId: fund.id, amount: dto.amount, category: dto.category },
    });

    this.events.emit(
      'ExpenseCreated',
      new ExpenseCreatedEvent(expense.id, buildingId, fund.id, dto.amount, actorPersonId),
    );

    return expense;
  }

  /**
   * VOIDs a POSTED Expense -- the only correction path (no edit endpoint).
   * `ExpensePolicy.assertVoidable` here is the fast, friendly pre-check
   * for the common (non-racy) already-voided case, giving the familiar
   * 422; `FinanceRepository.voidExpense`'s own CAS
   * (`updateMany({ where: { status: 'POSTED' } })`) is the authoritative
   * safety net for a genuinely-concurrent double-void this pre-check
   * cannot see, and throws a distinct 409 `ConflictError` only in that
   * rare case -- the same fast-pre-check / authoritative-CAS split
   * `VotingService.closeVote`/`cancelVote` already establish.
   */
  async voidExpense(
    buildingId: string,
    expenseId: string,
    dto: VoidExpenseDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const expense = await this.getOwnExpense(buildingId, expenseId);
    this.expensePolicy.assertVoidable(expense.status);

    const voided = await this.finance.voidExpense({
      expenseId,
      buildingId,
      fundId: expense.fundId,
      amount: expense.amount,
      voidReason: dto.voidReason,
      actorId: actorPersonId,
      requestId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ExpenseVoided',
      entityType: 'Expense',
      entityId: expenseId,
      requestId,
      reason: dto.voidReason,
      metadata: { amount: expense.amount },
    });

    this.events.emit(
      'ExpenseVoided',
      new ExpenseVoidedEvent(expenseId, buildingId, expense.fundId, expense.amount, actorPersonId),
    );

    return voided;
  }

  async getExpense(buildingId: string, expenseId: string) {
    return this.getOwnExpense(buildingId, expenseId);
  }

  /** Finance Hardening Pass style pagination, see `FinanceRepository.listFunds`'s own doc comment. */
  async listExpenses(
    buildingId: string,
    pagination: PaginationParams,
    filters?: {
      fundId?: string;
      category?: ExpenseCategory;
      status?: ExpenseStatus;
      fromDate?: Date;
      toDate?: Date;
    },
  ) {
    await this.getBuilding(buildingId);
    const { items, total } = await this.finance.listExpenses(
      buildingId,
      toSkipTake(pagination),
      filters,
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  // --- Reporting -----------------------------------------------------------------

  async getFinancialSummary(buildingId: string) {
    await this.getBuilding(buildingId);
    return this.finance.getFinancialSummary(buildingId);
  }

  /** Finance Hardening Pass — paginated, see `FinanceRepository.listFunds`'s own doc comment. */
  async listLedger(buildingId: string, fundId: string | undefined, pagination: PaginationParams) {
    await this.getBuilding(buildingId);
    const { items, total } = await this.finance.listLedger(
      buildingId,
      fundId,
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
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

  async listChargeSeries(buildingId: string) {
    await this.getBuilding(buildingId);
    return this.finance.listChargeSeries(buildingId);
  }

  async getChargeOptions(buildingId: string) {
    await this.getBuilding(buildingId);
    const funds = await this.finance.listActiveChargeOptionFunds(buildingId);
    return {
      chargeKinds: NEW_CHARGE_KIND_ORDER.map((kind) => ({
        kind,
        funds: funds.filter((fund) => this.chargeFundAlignment.isFundCompatible(kind, fund.type)),
      })).filter((option) => option.funds.length > 0),
    };
  }

  async createChargeSeries(buildingId: string, dto: CreateChargeSeriesDto) {
    await this.getBuilding(buildingId);
    const name = dto.name.trim();
    try {
      return await this.finance.createChargeSeries(buildingId, name);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new DuplicateError('A charge series with this name already exists.');
      }
      throw error;
    }
  }

  private async resolveChargeClassification(buildingId: string, dto: CreateChargeBatchDto) {
    this.chargePolicy.assertValidClassification(dto);
    if (dto.chargeKind !== 'MONTHLY') return null;
    const series = await this.finance.findChargeSeriesById(dto.seriesId!);
    if (!series || series.buildingId !== buildingId) {
      throw new NotFoundAppError('Charge series not found.');
    }
    if (!series.isActive) {
      throw new BusinessRuleViolationError('An inactive charge series cannot receive new charges.');
    }
    return series;
  }
}
