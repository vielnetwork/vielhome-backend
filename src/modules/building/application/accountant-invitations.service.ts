import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ConflictError, NotFoundAppError } from '../../../common/errors/app-error';

const pending = { acceptedAt: null, cancelledAt: null };
@Injectable()
export class AccountantInvitationsService {
  constructor(private readonly db: PrismaService) {}

  async list(buildingId: string) {
    const [invitations, accountants] = await Promise.all([
      this.db.accountantInvitation.findMany({
        where: { buildingId, ...pending },
        select: { id: true, phone: true },
      }),
      this.db.membership.findMany({
        where: { buildingId, role: 'ACCOUNTANT', isCurrent: true },
        select: { id: true, canIssueCharges: true, canManageFunds: true, person: { select: { firstName: true, lastName: true, phone: true } } },
      }),
    ]);
    return { invitations, accountants };
  }

  invite(buildingId: string, phone: string, invitedById: string) {
    return this.db.$transaction(async (tx) => {
      const active = await tx.membership.findFirst({
        where: { buildingId, person: { phone }, role: 'ACCOUNTANT', isCurrent: true },
      });
      if (active) throw new ConflictError('این شخص حسابدار فعال ساختمان است.');
      const existing = await tx.accountantInvitation.findFirst({
        where: { buildingId, phone, ...pending },
      });
      if (existing) return { id: existing.id };
      await tx.accountantInvitation.createMany({
        data: [{ buildingId, phone, invitedById }],
        skipDuplicates: true,
      });
      return tx.accountantInvitation.findFirstOrThrow({
        where: { buildingId, phone, ...pending },
        select: { id: true },
      });
    });
  }

  async mine(personId: string) {
    const { phone } = await this.db.person.findUniqueOrThrow({
      where: { id: personId },
      select: { phone: true },
    });
    return this.db.accountantInvitation.findMany({
      where: { phone, ...pending },
      select: { id: true, building: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  accept(id: string, personId: string) {
    return this.db.$transaction(async (tx) => {
      const { phone } = await tx.person.findUniqueOrThrow({
        where: { id: personId },
        select: { phone: true },
      });
      const changed = await tx.accountantInvitation.updateMany({
        where: { id, phone, ...pending },
        data: { acceptedAt: new Date() },
      });
      if (!changed.count) throw new NotFoundAppError('دعوت فعال برای این حساب پیدا نشد.');
      const invitation = await tx.accountantInvitation.findUniqueOrThrow({ where: { id } });
      const manager = await tx.membership.findFirst({
        where: {
          buildingId: invitation.buildingId,
          personId: invitation.invitedById,
          role: 'MANAGER',
          isCurrent: true,
        },
        select: { id: true },
      });
      if (!manager) throw new ConflictError('مدیر دعوت‌کننده دیگر در این ساختمان فعال نیست.');

      const existing = await tx.membership.findFirst({
        where: { buildingId: invitation.buildingId, personId, role: 'ACCOUNTANT', isCurrent: true },
      });
      if (!existing)
        await tx.membership.create({
          data: {
            personId,
            buildingId: invitation.buildingId,
            role: 'ACCOUNTANT',
            assignedById: invitation.invitedById,
          },
        });
      return { buildingId: invitation.buildingId };
    });
  }

  chargeUnits(buildingId: string) {
    return this.db.unit.findMany({
      where: { buildingId },
      select: { id: true, unitNumber: true },
      orderBy: { unitNumber: 'asc' },
    });
  }

  async delegations(buildingId: string, personId: string) {
    const rows = await this.db.membership.findMany({
      where: { buildingId, personId, role: 'ACCOUNTANT', isCurrent: true },
      select: { canIssueCharges: true, canManageFunds: true },
    });
    return {
      canIssueCharges: rows.some(row => row.canIssueCharges),
      canManageFunds: rows.some(row => row.canManageFunds),
    };
  }

  async setDelegation(buildingId: string, id: string, permission: 'canIssueCharges' | 'canManageFunds', enabled: boolean) {
    const changed = await this.db.membership.updateMany({
      where: { buildingId, id, role: 'ACCOUNTANT', isCurrent: true },
      data: { [permission]: enabled },
    });
    if (!changed.count) throw new NotFoundAppError('حسابدار فعال پیدا نشد.');
    return { id };
  }

  async cancel(buildingId: string, id: string) {
    const changed = await this.db.accountantInvitation.updateMany({
      where: { id, buildingId, ...pending },
      data: { cancelledAt: new Date() },
    });
    if (!changed.count) throw new ConflictError('دعوت دیگر در انتظار پذیرش نیست.');
    return { id };
  }

  async end(buildingId: string, id: string) {
    const changed = await this.db.membership.updateMany({
      where: { id, buildingId, role: 'ACCOUNTANT', isCurrent: true },
      data: { isCurrent: false, endedAt: new Date() },
    });
    if (!changed.count) throw new NotFoundAppError('حسابدار فعال پیدا نشد.');
    return { id };
  }
}
