import { Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ConflictError, NotFoundAppError } from '../../../common/errors/app-error';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

const outstanding = { acceptedAt: null, invitedAt: null };

@Controller({ version: '1' })
@UseGuards(JwtAuthGuard)
export class UnitContactInvitationsController {
  constructor(private readonly db: PrismaService) {}

  @Get('buildings/:id/unit-invites')
  @Header('Cache-Control', 'no-store')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  async count(@Param('id') buildingId: string) {
    return { count: await this.db.unitImportContact.count({
      where: { unit: { buildingId }, ...outstanding },
    }) };
  }

  @Post('buildings/:id/unit-invites')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  async inviteAll(@Param('id') buildingId: string, @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string) {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.unitImportContact.updateMany({
        where: { unit: { buildingId }, ...outstanding },
        data: { invitedAt: new Date(), invitedById: user.sub },
      });
      if (count) await tx.auditLog.create({ data: {
        actorId: user.sub, buildingId, requestId,
        action: 'UnitContactsInvited', entityType: 'Building', entityId: buildingId,
        metadata: { count },
      } });
      return { count };
    });
  }

  @Get('unit-invites')
  @Header('Cache-Control', 'no-store')
  async mine(@CurrentUser() user: JwtPayload) {
    const person = await this.db.person.findUniqueOrThrow({
      where: { id: user.sub }, select: { phone: true },
    });
    return this.db.unitImportContact.findMany({
      where: { phone: person.phone, acceptedAt: null, invitedAt: { not: null } },
      select: {
        unitId: true, role: true, leaseEndDate: true,
        unit: { select: { unitNumber: true, building: { select: { name: true } } } },
      },
      orderBy: { invitedAt: 'desc' },
    });
  }

  @Post('unit-invites/:unitId/:role/accept')
  async accept(@CurrentUser() user: JwtPayload, @Param('unitId') unitId: string,
    @Param('role') role: string, @RequestId() requestId: string) {
    if (role !== 'OWNER' && role !== 'TENANT') throw new NotFoundAppError('دعوت پیدا نشد.');
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM units WHERE id = ${unitId} FOR UPDATE`;
        const person = await tx.person.findUniqueOrThrow({ where: { id: user.sub } });
        const invite = await tx.unitImportContact.findFirst({
          where: { unitId, role, phone: person.phone, invitedAt: { not: null }, acceptedAt: null },
          include: { unit: { select: { buildingId: true } } },
        });
        if (!invite || !invite.invitedById) throw new NotFoundAppError('دعوت فعال برای این حساب پیدا نشد.');
        const buildingId = invite.unit.buildingId;
        const manager = await tx.membership.findFirst({
          where: { buildingId, personId: invite.invitedById, role: 'MANAGER', isCurrent: true },
          select: { id: true },
        });
        if (!manager) throw new ConflictError('مدیر دعوت‌کننده دیگر در این ساختمان فعال نیست.');
        const owner = await tx.ownership.findFirst({
          where: { unitId, isCurrent: true }, select: { personId: true },
        });
        if (role === 'OWNER') {
          if (owner) throw new ConflictError('این واحد مالک فعال دارد.');
          await tx.ownership.create({ data: { unitId, personId: person.id } });
        } else {
          if (!owner || owner.personId === person.id) {
            throw new ConflictError('ابتدا باید مالک واحد ثبت شده باشد.');
          }
          const tenancy = await tx.tenancy.findFirst({
            where: { unitId, isCurrent: true }, select: { id: true },
          });
          if (tenancy) throw new ConflictError('این واحد اجارهٔ فعال دارد.');
          if (invite.leaseEndDate && invite.leaseEndDate.toISOString().slice(0, 10) <= new Date().toISOString().slice(0, 10)) {
            throw new ConflictError('تاریخ پایان اجاره گذشته است.');
          }
          await tx.tenancy.create({ data: { unitId, personId: person.id, endDate: invite.leaseEndDate } });
          await tx.unit.update({ where: { id: unitId }, data: { occupancyStatus: 'TENANT_OCCUPIED' } });
        }
        await tx.membership.create({
          data: { buildingId, unitId, role, personId: person.id, assignedById: invite.invitedById },
        });
        await tx.person.update({
          where: { id: person.id },
          data: { firstName: person.firstName ?? invite.firstName, lastName: person.lastName ?? invite.lastName },
        });
        await tx.unitImportContact.update({
          where: { unitId_role: { unitId, role } }, data: { acceptedAt: new Date() },
        });
        await tx.auditLog.create({ data: {
          actorId: person.id, buildingId, requestId,
          action: 'UnitContactInvitationAccepted', entityType: 'Unit', entityId: unitId,
          metadata: { role },
        } });
        return { buildingId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictError('وضعیت واحد تغییر کرده است. دوباره بررسی کنید.');
      }
      throw error;
    }
  }
}
