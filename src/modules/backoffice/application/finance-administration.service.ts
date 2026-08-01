import { Injectable } from '@nestjs/common';
import type { PaymentStatus } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { FinanceRepository } from '../../finance/infrastructure/repositories/finance.repository';
import { FinanceService } from '../../finance/application/finance.service';
import { AdminReversePaymentDto } from './dto/admin-reverse-payment.dto';
import { RefundPaymentDto } from '../../finance/application/dto/refund-payment.dto';
import { NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';

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
  ) {}

  async list(
    filters: { search?: string; status?: PaymentStatus; buildingId?: string },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.backOffice.searchPayments(filters, toSkipTake(pagination));
    return { items, meta: buildPaginationMeta(pagination, total) };
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
