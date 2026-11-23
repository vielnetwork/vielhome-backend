import { Injectable } from '@nestjs/common';

import { AuthorizationError, ConflictError, NotFoundAppError } from '../../../common/errors/app-error';
import { normalizeIranianMobilePhone } from '../../../common/phone/phone.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RbacManagementService } from './rbac-management.service';

@Injectable()
export class OwnerRbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RbacManagementService,
  ) {}

  async listForPhone(phone: string) {
    const staff = await this.findStaff(phone);
    return this.roles.listActiveRolesForStaff(staff.id);
  }

  async assign(phone: string, roleId: string, ownerPersonId: string, requestId?: string) {
    const staff = await this.findStaff(phone);
    return this.roles.assignRole(staff.id, roleId, ownerPersonId, requestId);
  }

  async revoke(phone: string, assignmentId: string, ownerPersonId: string, requestId?: string) {
    const staff = await this.findStaff(phone);
    const assignment = await this.prisma.staffRole.findFirst({
      where: { id: assignmentId, staffId: staff.id, revokedAt: null },
      select: { id: true },
    });
    if (!assignment) throw new NotFoundAppError('Active role grant not found for this number.');
    return this.roles.revokeRole(assignment.id, ownerPersonId, requestId);
  }

  async invite(phone: string, roleId: string, actorId: string) {
    const normalized = normalizeIranianMobilePhone(phone);
    if (!normalized) throw new NotFoundAppError('Invalid mobile number.');
    return this.prisma.$transaction(async (tx) => {
      const active = await tx.platformStaff.findFirst({
        where: { isActive: true, person: { phone: normalized } },
      });
      if (active) throw new ConflictError('Use role assignment for active staff.');
      const invitation = await tx.backofficeRoleInvite.create({
        data: { phone: normalized, roleId, invitedById: actorId, expiresAt: new Date(Date.now() + 86_400_000) },
        select: { id: true, expiresAt: true },
      });
      await tx.auditLog.create({
        data: { actorId, action: 'BackofficeRoleInvited', entityType: 'BackofficeRoleInvite',
          entityId: invitation.id, metadata: { roleId } },
      });
      return invitation;
    });
  }

  async pendingInvites(personId: string) {
    const caller = await this.prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { phone: true } });
    return this.prisma.backofficeRoleInvite.findMany({
      where: { phone: caller.phone, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, expiresAt: true, role: { select: { name: true } } },
    });
  }

  acceptInvite(id: string, personId: string) {
    return this.prisma.$transaction(async (tx) => {
      const caller = await tx.person.findUniqueOrThrow({ where: { id: personId }, select: { phone: true } });
      const now = new Date();
      const claimed = await tx.backofficeRoleInvite.updateMany({
        where: { id, phone: caller.phone, acceptedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw new NotFoundAppError('Active invitation not found.');
      const invitation = await tx.backofficeRoleInvite.findUniqueOrThrow({ where: { id } });
      const staff = await tx.platformStaff.upsert({
        where: { personId },
        create: { personId, role: 'RBAC_ONLY' },
        update: {},
      });
      if (!staff.isActive) throw new AuthorizationError('This staff record is inactive.');
      const existing = await tx.staffRole.findFirst({
        where: { staffId: staff.id, roleId: invitation.roleId, revokedAt: null },
      });
      if (!existing) {
        const assignment = await tx.staffRole.create({
          data: { staffId: staff.id, roleId: invitation.roleId, assignedById: invitation.invitedById },
        });
        await tx.auditLog.create({ data: {
          actorId: invitation.invitedById, action: 'StaffRoleAssigned',
          entityType: 'StaffRole', entityId: assignment.id, metadata: { invitationId: id, acceptedById: personId },
        } });
      }
      return { accepted: true };
    });
  }

  private async findStaff(phone: string) {
    const normalized = normalizeIranianMobilePhone(phone);
    if (!normalized) throw new NotFoundAppError('Active backoffice account not found.');
    const staff = await this.prisma.platformStaff.findFirst({
      where: { isActive: true, person: { phone: normalized } },
      select: { id: true },
    });
    if (!staff) throw new NotFoundAppError('Active backoffice account not found.');
    return staff;
  }
}
