import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FinanceRepository } from '../infrastructure/repositories/finance.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { ChargePolicy } from '../domain/policies/charge.policy';
import { PaymentPolicy } from '../domain/policies/payment.policy';
import { CreateFundDto } from './dto/create-fund.dto';
import { CreateChargeBatchDto } from './dto/create-charge-batch.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { ReversePaymentDto } from './dto/reverse-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { ChargeBatchCancelledEvent, ChargeBatchIssuedEvent } from '../events/charge-batch.events';
import { PaymentApprovedEvent, PaymentRefundedEvent, PaymentRejectedEvent, PaymentReversedEvent } from '../events/payment.events';
import { AdjustmentCreatedEvent } from '../events/adjustment.events';

@Injectable()
export class FinanceService {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly buildings: BuildingRepository,
    private readonly chargePolicy: ChargePolicy,
    private readonly paymentPolicy: PaymentPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  // --- Funds -----------------------------------------------------------------

  async createFund(buildingId: string, dto: CreateFundDto, actorPersonId: string, requestId: string) {
    await this.getBuilding(buildingId);

    const fund = await this.finance.createFund({
      buildingId,
      name: dto.name,
      type: dto.type,
      description: dto.description,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'FundCreated',
      entityType: 'Fund',
      entityId: fund.id,
      requestId,
    });

    return fund;
  }

  listFunds(buildingId: string) {
    return this.finance.listFunds(buildingId);
  }

  // --- Charge Batches ----------------------------------------------------------

  /**
   * Resolves calculationMethod -> the concrete per-unit item list. See
   * CreateChargeBatchDto's class comment for what each method expects.
   */
  private async resolveChargeItems(buildingId: string, dto: CreateChargeBatchDto) {
    this.chargePolicy.assertValidCalculationInputs(dto.calculationMethod, dto);

    if (dto.calculationMethod === 'MIXED') {
      return dto.items!.map((i) => ({ unitId: i.unitId, amount: i.amount }));
    }

    const units = await this.buildings.listUnits(buildingId);

    if (dto.calculationMethod === 'FIXED') {
      return units.map((u) => ({ unitId: u.id, amount: dto.amountPerUnit! }));
    }

    // AREA_BASED — units with no areaSqm configured yet are skipped rather
    // than charged 0 (06_User_Flows: area is a "Configure Units" follow-up,
    // not guaranteed at skeleton-unit creation time).
    return units
      .filter((u) => u.areaSqm && u.areaSqm > 0)
      .map((u) => ({ unitId: u.id, amount: Math.round(dto.ratePerSqm! * (u.areaSqm as number)) }));
  }

  async createChargeBatch(buildingId: string, dto: CreateChargeBatchDto, actorPersonId: string, requestId: string) {
    await this.getBuilding(buildingId);

    const fund = dto.fundId
      ? await this.finance.findFundById(dto.fundId)
      : await this.finance.getOrCreateDefaultFund(buildingId);
    if (!fund || fund.buildingId !== buildingId) {
      throw new NotFoundAppError('Fund not found.');
    }

    const items = await this.resolveChargeItems(buildingId, dto);

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
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'ChargeBatchCreated',
      entityType: 'ChargeBatch',
      entityId: batch.id,
      requestId,
      metadata: { calculationMethod: dto.calculationMethod, itemCount: items.length },
    });

    return batch;
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

  async issueChargeBatch(buildingId: string, chargeBatchId: string, actorPersonId: string, requestId: string) {
    const batch = await this.getChargeBatch(buildingId, chargeBatchId);
    this.chargePolicy.assertIssuable(batch.status, batch.totalAmount);

    const issued = await this.finance.issueChargeBatch({
      chargeBatchId,
      buildingId,
      fundId: batch.fundId,
      totalAmount: batch.totalAmount,
      actorId: actorPersonId,
      requestId,
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

  async cancelChargeBatch(buildingId: string, chargeBatchId: string, actorPersonId: string, requestId: string) {
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

    this.events.emit('ChargeBatchCancelled', new ChargeBatchCancelledEvent(chargeBatchId, buildingId, actorPersonId));

    return cancelled;
  }

  private async getOwnUnit(buildingId: string, unitId: string) {
    const unit = await this.buildings.findUnitById(unitId);
    if (!unit || unit.buildingId !== buildingId) {
      throw new NotFoundAppError('Unit not found.');
    }
    return unit;
  }

  async listUnitChargeItems(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    return this.finance.listChargeItemsByUnit(unitId);
  }

  // --- Adjustments (08.05 Rule 014 — see 21_ADRs > ADR-037) -------------------

  async createAdjustment(buildingId: string, unitId: string, dto: CreateAdjustmentDto, actorPersonId: string, requestId: string) {
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

    this.events.emit('AdjustmentCreated', new AdjustmentCreatedEvent(adjustment.id, buildingId, unitId, dto.amount, actorPersonId));

    return adjustment;
  }

  async listUnitAdjustments(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    return this.finance.listAdjustmentsByUnit(unitId);
  }

  async getUnitDebt(buildingId: string, unitId: string) {
    await this.getOwnUnit(buildingId, unitId);
    return this.finance.getUnitDebt(unitId);
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
  async createPayment(buildingId: string, unitId: string, dto: CreatePaymentDto, actorPersonId: string, requestId: string) {
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

  async approvePayment(buildingId: string, paymentId: string, actorPersonId: string, requestId: string) {
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
      new PaymentApprovedEvent(paymentId, buildingId, payment.unitId, payment.amount, actorPersonId, payment.payerId),
    );

    return approved;
  }

  async rejectPayment(buildingId: string, paymentId: string, dto: RejectPaymentDto, actorPersonId: string, requestId: string) {
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

    this.events.emit('PaymentRejected', new PaymentRejectedEvent(paymentId, buildingId, payment.unitId, actorPersonId));

    return rejected;
  }

  /** Undoes an erroneous/bounced/fraudulent APPROVED payment (08.06 Rule 010/014 — see 21_ADRs > ADR-037). */
  async reversePayment(buildingId: string, paymentId: string, dto: ReversePaymentDto, actorPersonId: string, requestId: string) {
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
      new PaymentReversedEvent(paymentId, buildingId, payment.unitId, payment.amount, actorPersonId),
    );

    return reversed;
  }

  /** Returns cash to the payer on a valid, already-APPROVED payment (08.06 Rules 010/013/015 — see 21_ADRs > ADR-037). */
  async refundPayment(buildingId: string, paymentId: string, dto: RefundPaymentDto, actorPersonId: string, requestId: string) {
    const payment = await this.getOwnPayment(buildingId, paymentId);
    const existingRefunds = await this.finance.findRefundsByPayment(paymentId);
    const refundAmount = dto.amount ?? payment.amount;
    this.paymentPolicy.assertRefundable(payment.status, refundAmount, payment.amount, existingRefunds.length > 0);

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
