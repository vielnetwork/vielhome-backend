import {
  ServiceContractInvoiceStatus,
  ServiceContractPaymentStatus,
  ServiceContractStatus,
} from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import { ConflictError, ValidationError } from '../../../common/errors/app-error';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ServiceContractsService } from './service-contracts.service';

describe('ServiceContractsService', () => {
  let prisma: Record<string, { findUnique?: jest.Mock; create?: jest.Mock; findMany?: jest.Mock; findFirst?: jest.Mock; update?: jest.Mock }>;
  let audit: { record: jest.Mock };
  let service: ServiceContractsService;

  const dto = {
    customerFirstName: 'مینا',
    customerLastName: 'رضایی',
    customerPhone: '09121234567',
    title: 'اجاره سالن',
    amount: 500_000,
  };

  beforeEach(() => {
    prisma = {
      person: { findUnique: jest.fn(), create: jest.fn() },
      serviceContract: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    };
    audit = { record: jest.fn() };
    service = new ServiceContractsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  it('creates an external customer profile without a Membership', async () => {
    prisma.person.findUnique!.mockResolvedValue(null);
    prisma.person.create!.mockResolvedValue({ id: 'customer-1' });
    prisma.serviceContract.create!.mockResolvedValue({ id: 'contract-1' });

    await expect(service.create('building-1', dto, 'manager-1', 'req-1')).resolves.toEqual({
      id: 'contract-1',
    });

    expect(prisma.person.create).toHaveBeenCalledWith({
      data: {
        phone: dto.customerPhone,
        firstName: dto.customerFirstName,
        lastName: dto.customerLastName,
      },
    });
    expect(prisma.serviceContract.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          buildingId: 'building-1',
          customerPersonId: 'customer-1',
          managedById: 'manager-1',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ServiceContractCreated' }));
  });

  it('rejects an end date before the start date before writing anything', async () => {
    await expect(
      service.create(
        'building-1',
        { ...dto, startsAt: '2026-11-20T10:00:00.000Z', endsAt: '2026-11-20T09:00:00.000Z' },
        'manager-1',
        'req-1',
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prisma.person.findUnique).not.toHaveBeenCalled();
  });

  it('ends an active contract but refuses to alter ended history', async () => {
    prisma.serviceContract.findFirst!.mockResolvedValue({
      id: 'contract-1',
      status: ServiceContractStatus.ACTIVE,
      endsAt: null,
    });
    prisma.serviceContract.update!.mockResolvedValue({ id: 'contract-1', status: ServiceContractStatus.ENDED });

    await service.end('building-1', 'contract-1', 'manager-1', 'req-1');

    expect(prisma.serviceContract.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'contract-1' },
        data: expect.objectContaining({ status: ServiceContractStatus.ENDED }),
      }),
    );

    prisma.serviceContract.findFirst!.mockResolvedValue({
      id: 'contract-1',
      status: ServiceContractStatus.ENDED,
    });
    await expect(service.end('building-1', 'contract-1', 'manager-1', 'req-2')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(prisma.serviceContract.update).toHaveBeenCalledTimes(1);
  });

  it('scopes the customer view to the authenticated customer id', async () => {
    prisma.serviceContract.findMany!.mockResolvedValue([]);
    await service.listMine('customer-1');
    expect(prisma.serviceContract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerPersonId: 'customer-1' } }),
    );
  });

  it('posts an approved external payment to the fund ledger and invoice', async () => {
    const tx = {
      serviceContractPayment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'payment-1',
          buildingId: 'building-1',
          fundId: 'fund-1',
          amount: 300_000,
          status: ServiceContractPaymentStatus.PENDING_APPROVAL,
          invoiceId: 'invoice-1',
          invoice: { title: 'اجاره سالن', amount: 500_000, paidAmount: 200_000 },
          fund: { isActive: true },
        }),
        update: jest.fn().mockResolvedValue({ id: 'payment-1' }),
      },
      serviceContractInvoice: { update: jest.fn() },
      ledgerEntry: { create: jest.fn() },
      fund: { update: jest.fn() },
    };
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest
      .fn()
      .mockImplementation((operation: (client: typeof tx) => unknown) => operation(tx));

    await service.approvePayment('building-1', 'payment-1', 'manager-1', 'req-1');

    expect(tx.serviceContractInvoice.update).toHaveBeenCalledWith({
      where: { id: 'invoice-1' },
      data: { paidAmount: 500_000, status: ServiceContractInvoiceStatus.PAID },
    });
    expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 300_000,
          referenceType: 'ServiceContractPayment',
          referenceId: 'payment-1',
        }),
      }),
    );
    expect(tx.fund.update).toHaveBeenCalledWith({
      where: { id: 'fund-1' },
      data: { balance: { increment: 300_000 } },
    });
  });
});
