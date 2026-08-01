import { FinanceAdministrationService } from './finance-administration.service';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { FinanceRepository } from '../../finance/infrastructure/repositories/finance.repository';
import { FinanceService } from '../../finance/application/finance.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { AuditService } from '../../../common/audit/audit.service';

/**
 * 21_ADRs > ADR-113 — Financial Administration (Stage 6).
 * `BackOfficeRepository`/`FinanceRepository`/`FinanceService` are all
 * fully mocked. Covers: list/detail pass filters and pagination through
 * unmodified; `reverse`/`refund` both 404 on an unknown payment (never
 * touching `FinanceService` in that case), otherwise look up the
 * payment's `buildingId` via `FinanceRepository.findPaymentById` and
 * delegate to the real `FinanceService.reversePayment`/`refundPayment`
 * with the distinct `PaymentReversedByAdmin`/`PaymentRefundedByAdmin`
 * audit-action override — never bypassing `FinanceService` to call
 * `FinanceRepository.reversePayment`/`createRefund` directly, which would
 * silently drop the real payer-notification/gamification event emission.
 */
describe('FinanceAdministrationService', () => {
  let backOffice: {
    searchPayments: jest.Mock;
    getPaymentAdminDetail: jest.Mock;
  };
  let financeRepository: { findPaymentById: jest.Mock };
  let financeService: { reversePayment: jest.Mock; refundPayment: jest.Mock };
  let audit: { record: jest.Mock };
  let service: FinanceAdministrationService;

  beforeEach(() => {
    backOffice = {
      searchPayments: jest.fn(),
      getPaymentAdminDetail: jest.fn(),
    };
    financeRepository = { findPaymentById: jest.fn() };
    financeService = {
      reversePayment: jest.fn(),
      refundPayment: jest.fn(),
    };
    audit = { record: jest.fn() };
    service = new FinanceAdministrationService(
      backOffice as unknown as BackOfficeRepository,
      financeRepository as unknown as FinanceRepository,
      financeService as unknown as FinanceService,
      audit as unknown as AuditService,
    );
  });

  describe('list', () => {
    it('passes filters and pagination through to the repository, and builds pagination meta from the total', async () => {
      backOffice.searchPayments.mockResolvedValue({
        items: [{ id: 'pay-1' }, { id: 'pay-2' }],
        total: 30,
      });

      const result = await service.list(
        { search: 'ali', status: 'APPROVED', buildingId: 'b1' },
        { page: 2, limit: 10 },
      );

      expect(backOffice.searchPayments).toHaveBeenCalledWith(
        { search: 'ali', status: 'APPROVED', buildingId: 'b1' },
        { skip: 10, take: 10 },
      );
      expect(result.items).toHaveLength(2);
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 30, totalPages: 3 });
    });
  });

  describe('getDetail', () => {
    it('returns the repository row when found', async () => {
      const row = { id: 'pay-1', amount: 1000 };
      backOffice.getPaymentAdminDetail.mockResolvedValue(row);

      await expect(service.getDetail('pay-1')).resolves.toBe(row);
    });

    it('throws NotFoundAppError when the payment does not exist', async () => {
      backOffice.getPaymentAdminDetail.mockResolvedValue(null);

      await expect(service.getDetail('missing')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('reverse', () => {
    it('throws NotFoundAppError for an unknown payment and never calls FinanceService', async () => {
      financeRepository.findPaymentById.mockResolvedValue(null);

      await expect(
        service.reverse('missing', 'actor-1', { reason: 'fraud' }, 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(financeService.reversePayment).not.toHaveBeenCalled();
    });

    it('looks up the buildingId and delegates to FinanceService.reversePayment with the PaymentReversedByAdmin override', async () => {
      financeRepository.findPaymentById.mockResolvedValue({ id: 'pay-1', buildingId: 'b1' });
      financeService.reversePayment.mockResolvedValue({ id: 'pay-1', status: 'REVERSED' });

      const dto = { reason: 'Confirmed duplicate charge.' };
      const result = await service.reverse('pay-1', 'actor-1', dto, 'req-1');

      expect(financeService.reversePayment).toHaveBeenCalledWith(
        'b1',
        'pay-1',
        dto,
        'actor-1',
        'req-1',
        { auditAction: 'PaymentReversedByAdmin' },
      );
      expect(result).toEqual({ id: 'pay-1', status: 'REVERSED' });
    });
  });

  describe('refund', () => {
    it('throws NotFoundAppError for an unknown payment and never calls FinanceService', async () => {
      financeRepository.findPaymentById.mockResolvedValue(null);

      await expect(
        service.refund('missing', 'actor-1', { reason: 'appeal' }, 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(financeService.refundPayment).not.toHaveBeenCalled();
    });

    it('looks up the buildingId and delegates to FinanceService.refundPayment with the PaymentRefundedByAdmin override', async () => {
      financeRepository.findPaymentById.mockResolvedValue({ id: 'pay-1', buildingId: 'b1' });
      financeService.refundPayment.mockResolvedValue({ id: 'refund-1', amount: 5000 });

      const dto = { reason: 'Goodwill refund.', amount: 5000 };
      const result = await service.refund('pay-1', 'actor-1', dto, 'req-1');

      expect(financeService.refundPayment).toHaveBeenCalledWith(
        'b1',
        'pay-1',
        dto,
        'actor-1',
        'req-1',
        { auditAction: 'PaymentRefundedByAdmin' },
      );
      expect(result).toEqual({ id: 'refund-1', amount: 5000 });
    });
  });

  describe('exportCsv (ADR-115 — Reports & Export)', () => {
    it('calls searchPayments with skip:0 and the export row cap, flattens the payer, and returns a CSV string', async () => {
      backOffice.searchPayments.mockResolvedValue({
        items: [
          {
            id: 'pay-1',
            buildingId: 'b1',
            unitId: 'u1',
            fundId: 'f1',
            amount: 5000,
            method: 'CARD',
            status: 'APPROVED',
            reference: 'ref-1',
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            payer: { id: 'payer-1', fullName: 'Alice', phone: '+989120000099' },
          },
        ],
        total: 1,
      });

      const csv = await service.exportCsv({ status: 'APPROVED' }, 'actor-1', 'req-1');

      expect(backOffice.searchPayments).toHaveBeenCalledWith(
        { status: 'APPROVED' },
        { skip: 0, take: 5000 },
      );
      expect(csv.split('\n')[0]).toBe(
        'id,buildingId,unitId,fundId,amount,method,status,reference,createdAt,payerId,payerFullName,payerPhone',
      );
      expect(csv).toContain('pay-1');
      expect(csv).toContain('Alice');
      expect(csv).toContain('+989120000099');
    });

    it('records a PaymentListExported audit event with the filters and row count, no reason', async () => {
      backOffice.searchPayments.mockResolvedValue({ items: [{ id: 'pay-1' }], total: 1 });

      await service.exportCsv({ status: 'APPROVED' }, 'actor-1', 'req-1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          action: 'PaymentListExported',
          entityType: 'Payment',
          entityId: 'search',
          requestId: 'req-1',
          metadata: { filters: { status: 'APPROVED' }, rowCount: 1 },
        }),
      );
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.anything() }),
      );
    });
  });
});
