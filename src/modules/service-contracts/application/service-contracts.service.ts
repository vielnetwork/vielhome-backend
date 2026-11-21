import { Injectable } from '@nestjs/common';
import {
  LedgerDirection,
  LedgerEntryType,
  ServiceContractInvoiceStatus,
  ServiceContractPaymentStatus,
  ServiceContractStatus,
} from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateServiceContractDto } from './dto/create-service-contract.dto';
import { ReportServiceContractPaymentDto } from './dto/report-service-contract-payment.dto';

const customerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
} as const;

const managerSelect = {
  id: true,
  firstName: true,
  lastName: true,
} as const;

/**
 * Contracts for common-area rentals and other building services.
 *
 * A service customer deliberately has no Membership: they never inherit a
 * resident's ability to browse the building. Their identity is only linked to
 * a contract by phone, allowing the OTP account to be activated later.
 */
@Injectable()
export class ServiceContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    buildingId: string,
    dto: CreateServiceContractDto,
    managerPersonId: string,
    requestId: string,
  ) {
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date();
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (endsAt && endsAt <= startsAt) {
      throw new ValidationError('The contract end date must be after its start date.');
    }

    // Do not overwrite an existing account holder's name. A manager may only
    // supply missing identity fields when inviting a new service customer.
    let customer = await this.prisma.person.findUnique({ where: { phone: dto.customerPhone } });
    if (!customer) {
      customer = await this.prisma.person.create({
        data: {
          phone: dto.customerPhone,
          firstName: dto.customerFirstName.trim(),
          lastName: dto.customerLastName.trim(),
        },
      });
    }

    const contract = await this.prisma.serviceContract.create({
      data: {
        buildingId,
        customerPersonId: customer.id,
        managedById: managerPersonId,
        title: dto.title.trim(),
        amount: dto.amount,
        startsAt,
        endsAt,
        // The agreed amount immediately becomes a customer-specific
        // receivable. It is deliberately not a ChargeItem: no unit or
        // resident can ever see or settle this third-party obligation.
        invoices: {
          create: {
            buildingId,
            title: dto.title.trim(),
            amount: dto.amount,
            dueDate: endsAt,
          },
        },
      },
      include: {
        customer: { select: customerSelect },
        managedBy: { select: managerSelect },
        invoices: true,
      },
    });

    await this.audit.record({
      actorId: managerPersonId,
      buildingId,
      action: 'ServiceContractCreated',
      entityType: 'ServiceContract',
      entityId: contract.id,
      requestId,
      metadata: { customerPersonId: customer.id, amount: dto.amount },
    });

    return contract;
  }

  listForBuilding(buildingId: string) {
    return this.prisma.serviceContract.findMany({
      where: { buildingId },
      orderBy: [{ status: 'asc' }, { startsAt: 'desc' }],
      include: { customer: { select: customerSelect }, managedBy: { select: managerSelect } },
    });
  }

  async end(buildingId: string, contractId: string, managerPersonId: string, requestId: string) {
    const contract = await this.prisma.serviceContract.findFirst({
      where: { id: contractId, buildingId },
    });
    if (!contract) throw new NotFoundAppError('Service contract not found for this building.');
    if (contract.status === ServiceContractStatus.ENDED) {
      throw new ConflictError('This service contract has already ended.');
    }

    const ended = await this.prisma.serviceContract.update({
      where: { id: contractId },
      data: { status: ServiceContractStatus.ENDED, endsAt: contract.endsAt ?? new Date() },
      include: { customer: { select: customerSelect }, managedBy: { select: managerSelect } },
    });

    await this.audit.record({
      actorId: managerPersonId,
      buildingId,
      action: 'ServiceContractEnded',
      entityType: 'ServiceContract',
      entityId: contractId,
      requestId,
    });

    return ended;
  }

  /** A non-member service customer can only see contracts they are a party to. */
  listMine(customerPersonId: string) {
    return this.prisma.serviceContract.findMany({
      where: { customerPersonId },
      orderBy: { startsAt: 'desc' },
      include: {
        building: { select: { id: true, name: true, city: true } },
      },
    });
  }

  listInvoicesForBuilding(buildingId: string) {
    return this.prisma.serviceContractInvoice.findMany({
      where: { buildingId },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        contract: {
          select: { id: true, title: true, customer: { select: customerSelect } },
        },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  listMyInvoices(customerPersonId: string) {
    return this.prisma.serviceContractInvoice.findMany({
      where: { contract: { customerPersonId } },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      include: {
        contract: { select: { id: true, title: true } },
        building: { select: { id: true, name: true, city: true } },
        payments: { where: { payerId: customerPersonId }, orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async reportPayment(
    invoiceId: string,
    dto: ReportServiceContractPaymentDto,
    payerPersonId: string,
    requestId: string,
  ) {
    const invoice = await this.prisma.serviceContractInvoice.findUnique({
      where: { id: invoiceId },
      include: { contract: { select: { customerPersonId: true } } },
    });
    if (!invoice) throw new NotFoundAppError('Service contract invoice not found.');
    if (invoice.contract.customerPersonId !== payerPersonId) {
      throw new AuthorizationError('You may only report payment for your own service contract.');
    }
    if (invoice.status === ServiceContractInvoiceStatus.PAID) {
      throw new BusinessRuleViolationError('This service contract invoice has already been paid.');
    }

    if (dto.idempotencyKey) {
      const existing = await this.prisma.serviceContractPayment.findFirst({
        where: { invoiceId, payerId: payerPersonId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) return existing;
    }

    const [pending, fund] = await Promise.all([
      this.prisma.serviceContractPayment.aggregate({
        where: { invoiceId, status: ServiceContractPaymentStatus.PENDING_APPROVAL },
        _sum: { amount: true },
      }),
      this.prisma.fund.findFirst({ where: { buildingId: invoice.buildingId, isDefault: true, isActive: true } }),
    ]);
    const reservable = invoice.amount - invoice.paidAmount - (pending._sum.amount ?? 0);
    if (dto.amount > reservable) {
      throw new BusinessRuleViolationError('The reported amount exceeds the remaining invoice amount.');
    }
    if (!fund) throw new NotFoundAppError('No active default fund exists for this building.');

    const payment = await this.prisma.serviceContractPayment.create({
      data: {
        invoiceId,
        buildingId: invoice.buildingId,
        fundId: fund.id,
        payerId: payerPersonId,
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference,
        note: dto.note,
        idempotencyKey: dto.idempotencyKey,
      },
    });
    await this.audit.record({
      actorId: payerPersonId,
      buildingId: invoice.buildingId,
      action: 'ServiceContractPaymentReported',
      entityType: 'ServiceContractPayment',
      entityId: payment.id,
      requestId,
      metadata: { invoiceId, amount: dto.amount, method: dto.method },
    });
    return payment;
  }

  async approvePayment(
    buildingId: string,
    paymentId: string,
    approverPersonId: string,
    requestId: string,
  ) {
    const approved = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.serviceContractPayment.findUnique({
        where: { id: paymentId },
        include: { invoice: true, fund: true },
      });
      if (!payment || payment.buildingId !== buildingId) {
        throw new NotFoundAppError('Service contract payment not found for this building.');
      }
      if (payment.status !== ServiceContractPaymentStatus.PENDING_APPROVAL) {
        throw new BusinessRuleViolationError('Only a pending service contract payment can be approved.');
      }
      if (!payment.fund.isActive) {
        throw new BusinessRuleViolationError('The selected fund is no longer active.');
      }
      if (payment.invoice.paidAmount + payment.amount > payment.invoice.amount) {
        throw new ConflictError('This invoice changed before the payment could be approved.');
      }

      const paidAmount = payment.invoice.paidAmount + payment.amount;
      await tx.serviceContractInvoice.update({
        where: { id: payment.invoiceId },
        data: {
          paidAmount,
          status:
            paidAmount === payment.invoice.amount
              ? ServiceContractInvoiceStatus.PAID
              : ServiceContractInvoiceStatus.PARTIALLY_PAID,
        },
      });
      const updatedPayment = await tx.serviceContractPayment.update({
        where: { id: paymentId },
        data: {
          status: ServiceContractPaymentStatus.APPROVED,
          approvedById: approverPersonId,
          approvedAt: new Date(),
        },
      });
      await tx.ledgerEntry.create({
        data: {
          buildingId,
          fundId: payment.fundId,
          entryType: LedgerEntryType.PAYMENT,
          direction: LedgerDirection.CREDIT,
          amount: payment.amount,
          referenceType: 'ServiceContractPayment',
          referenceId: paymentId,
          description: `Service contract income: ${payment.invoice.title}`,
          actorId: approverPersonId,
          requestId,
        },
      });
      await tx.fund.update({
        where: { id: payment.fundId },
        data: { balance: { increment: payment.amount } },
      });
      return updatedPayment;
    });

    await this.audit.record({
      actorId: approverPersonId,
      buildingId,
      action: 'ServiceContractPaymentApproved',
      entityType: 'ServiceContractPayment',
      entityId: paymentId,
      requestId,
    });
    return approved;
  }

  async rejectPayment(
    buildingId: string,
    paymentId: string,
    reason: string,
    approverPersonId: string,
    requestId: string,
  ) {
    const payment = await this.prisma.serviceContractPayment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.buildingId !== buildingId) {
      throw new NotFoundAppError('Service contract payment not found for this building.');
    }
    if (payment.status !== ServiceContractPaymentStatus.PENDING_APPROVAL) {
      throw new BusinessRuleViolationError('Only a pending service contract payment can be rejected.');
    }
    const rejected = await this.prisma.serviceContractPayment.update({
      where: { id: paymentId },
      data: { status: ServiceContractPaymentStatus.REJECTED, rejectedReason: reason },
    });
    await this.audit.record({
      actorId: approverPersonId,
      buildingId,
      action: 'ServiceContractPaymentRejected',
      entityType: 'ServiceContractPayment',
      entityId: paymentId,
      reason,
      requestId,
    });
    return rejected;
  }
}
