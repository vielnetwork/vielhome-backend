import { Injectable } from '@nestjs/common';
import type { PaymentStatus } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { FinanceRepository } from '../../finance/infrastructure/repositories/finance.repository';
import { FinanceService } from '../../finance/application/finance.service';
import { AdminReversePaymentDto } from './dto/admin-reverse-payment.dto';
import { RefundPaymentDto } from '../../finance/application/dto/refund-payment.dto';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { AuditService } from '../../../common/audit/audit.service';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { toCsv, DEFAULT_EXPORT_ROW_CAP } from '../../../common/csv/csv.util';

/**
 * 21_ADRs > ADR-113 — Financial Administration (Stage 6). List/search/
 * detail are pure cross-building reads over `Payment`; `reverse`/`refund`
 * are the two direct staff actions.
 *
 * Unlike `UserAdministrationService.suspend`/`reinstate` (ADR-111) and
 * `BuildingAdministrationService.lock`/`reinstate` (ADR-112) — both of
 * which call their target repository's mutation method directly — this
 * service deliberately calls the full `FinanceService.reversePayment`/
 * `refundPayment` methods, not `FinanceRepository.reversePayment`/
 * `createRefund` directly. Those `FinanceService` methods own real
 * business-rule guards (`PaymentPolicy.assertReversible`/`assertRefundable`)
 * and emit `PaymentReversedEvent`/`PaymentRefundedEvent` — events that
 * drive an actual payer notification and a real Gamification score effect
 * (see `NotificationEventListenerService`/`GamificationEventListenerService`).
 * Bypassing `FinanceService` to call the repository directly, the way the
 * two prior stages did, would silently drop both of those real side
 * effects for a staff-initiated reversal/refund — a regression this stage
 * must not introduce. `FinanceService.reversePayment`/`refundPayment` were
 * given a small additive `options.auditAction` parameter for exactly this
 * reuse (see ADR-113), so the audit trail can still distinguish this
 * staff-direct path from the in-building one without duplicating any of
 * the policy/event logic.
 */
@Injectable()
export class FinanceAdministrationService {
  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly financeRepository: FinanceRepository,
    private readonly financeService: FinanceService,
    private readonly audit: AuditService,
  ) {}

  async list(
    filters: { search?: string; status?: PaymentStatus; buildingId?: string },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.searchPayments(filters, toSkipTake(pagination));
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  /** 21_ADRs > ADR-115 — Reports & Export (Stage 8). Calls the exact
   * same `searchPayments` query `list` already uses (same filters, no
   * new Prisma query), capped at `DEFAULT_EXPORT_ROW_CAP` rows instead
   * of paginated, and records a read-access audit event — same
   * precedent as `UserAdministrationService.exportCsv`. The nested
   * `payer` object `searchPayments` returns is flattened into
   * `payerId`/`payerFullName`/`payerPhone` columns — `toCsv` reads flat
   * `row[column]` values only, same as `AuditService.exportCsv`'s own
   * flat row shape. No `reason` — export is a read, not a mutation. */
  async exportCsv(
    filters: { search?: string; status?: PaymentStatus; buildingId?: string },
    actorPersonId: string,
    requestId: string,
  ): Promise<string> {
    const { items } = await this.backOffice.searchPayments(filters, {
      skip: 0,
      take: DEFAULT_EXPORT_ROW_CAP,
    });

    await this.audit.record({
      actorId: actorPersonId,
      action: 'PaymentListExported',
      entityType: 'Payment',
      entityId: 'search',
      requestId,
      metadata: { filters, rowCount: items.length },
    });

    const rows = items.map((item) => ({
      id: item.id,
      buildingId: item.buildingId,
      unitId: item.unitId,
      fundId: item.fundId,
      amount: item.amount,
      method: item.method,
      status: item.status,
      reference: item.reference,
      createdAt: item.createdAt,
      payerId: item.payer?.id ?? null,
      payerFullName: item.payer?.fullName ?? null,
      payerPhone: item.payer?.phone ?? null,
    }));

    return toCsv(rows, [
      'id',
      'buildingId',
      'unitId',
      'fundId',
      'amount',
      'method',
      'status',
      'reference',
      'createdAt',
      'payerId',
      'payerFullName',
      'payerPhone',
    ]);
  }

  async getDetail(paymentId: string) {
    const payment = await this.backOffice.getPaymentAdminDetail(paymentId);
    if (!payment) {
      throw new NotFoundAppError('Payment not found.');
    }
    return payment;
  }

  async reverse(
    paymentId: string,
    actorPersonId: string,
    dto: AdminReversePaymentDto,
    requestId: string,
  ) {
    const payment = await this.financeRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new NotFoundAppError('Payment not found.');
    }
    return this.financeService.reversePayment(
      payment.buildingId,
      paymentId,
      dto,
      actorPersonId,
      requestId,
      { auditAction: 'PaymentReversedByAdmin' },
    );
  }

  async refund(paymentId: string, actorPersonId: string, dto: RefundPaymentDto, requestId: string) {
    const payment = await this.financeRepository.findPaymentById(paymentId);
    if (!payment) {
      throw new NotFoundAppError('Payment not found.');
    }
    return this.financeService.refundPayment(
      payment.buildingId,
      paymentId,
      dto,
      actorPersonId,
      requestId,
      { auditAction: 'PaymentRefundedByAdmin' },
    );
  }
}
