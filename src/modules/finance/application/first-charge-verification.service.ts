import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AuthorizationError,
  ConflictError,
  NotFoundAppError,
} from '../../../common/errors/app-error';

@Injectable()
export class FirstChargeVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  private currentManager(db: Prisma.TransactionClient, buildingId: string) {
    return db.membership.findFirst({
      where: {
        buildingId,
        role: 'MANAGER',
        isCurrent: true,
        managerState: { in: ['PROVISIONAL', 'VERIFIED'] },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: { person: { select: { fullName: true, firstName: true, lastName: true } } },
    });
  }

  private lock(db: Prisma.TransactionClient, buildingId: string) {
    return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'first-charge:' + buildingId}))`;
  }

  async authorizeIssue(buildingId: string, draftId: string, actorId: string, requestId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, buildingId);
      const manager = await this.currentManager(tx, buildingId);
      if (!manager) throw new AuthorizationError('This building has no active manager.');
      const draft = await tx.chargeBatch.findFirst({
        where: { id: draftId, buildingId, status: 'DRAFT', totalAmount: { gt: 0 } },
        select: { id: true },
      });
      if (!draft) throw new NotFoundAppError('Charge draft not found.');
      const alreadyIssued = await tx.chargeBatch.findFirst({
        where: { buildingId, issuedAt: { gte: manager.startedAt } },
        select: { id: true },
      });
      if (alreadyIssued) return { membershipId: manager.id };

      let poll = await tx.chargeVerificationPoll.findUnique({
        where: { membershipId: manager.id },
        include: { draft: { select: { status: true } } },
      });
      if (!poll) {
        const units = await tx.unit.findMany({
          where: { buildingId },
          select: { id: true },
          take: 21,
        });
        if (units.length === 0) throw new ConflictError('The building has no units.');
        poll = await tx.chargeVerificationPoll.create({
          data: {
            membershipId: manager.id,
            draftId,
            requiredApprovals: units.length >= 21 ? 0 : Math.ceil((units.length * 51) / 100),
            unitIds: units.length >= 21 ? [] : units.map(({ id }) => id),
          },
          include: { draft: { select: { status: true } } },
        });
        await tx.auditLog.create({
          data: {
            buildingId,
            actorId,
            requestId,
            action: 'FirstChargeVerificationOpened',
            entityType: 'ChargeVerificationPoll',
            entityId: poll.id,
            metadata: { draftId, requiredApprovals: poll.requiredApprovals },
          },
        });
      } else if (poll.draft.status === 'CANCELLED') {
        poll = await tx.chargeVerificationPoll.update({
          where: { id: poll.id },
          data: { draftId },
          include: { draft: { select: { status: true } } },
        });
      }
      const approved =
        poll.requiredApprovals === 0
          ? await this.hasApprovedMinutes(tx, manager.id)
          : !!poll.approvedAt;
      if (!approved || actorId !== manager.personId || poll.draftId !== draftId) {
        return { pending: true, draftId: poll.draftId, approved } as const;
      }
      return { membershipId: manager.id };
    });
    if ('pending' in result) {
      throw new ConflictError('FIRST_CHARGE_VERIFICATION_REQUIRED', {
        reason: 'FIRST_CHARGE_VERIFICATION_REQUIRED',
        draftId: result.draftId,
        approved: result.approved,
      });
    }
    return result.membershipId;
  }

  private async hasApprovedMinutes(db: Prisma.TransactionClient, membershipId: string) {
    return !!(await db.managerVerificationCase.findFirst({
      where: { membershipId, boardMinutesStorageKey: { not: null }, status: 'VERIFIED' },
      select: { id: true },
    }));
  }

  private eligibleUnits(db: Prisma.TransactionClient, buildingId: string, personId: string) {
    const now = new Date();
    const current = {
      personId,
      isCurrent: true,
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gt: now } }],
    };
    return db.unit.findMany({
      where: {
        buildingId,
        OR: [
          { ownerships: { some: current } },
          { tenancies: { some: { ...current, status: { in: ['ACTIVE', 'NOTICE_GIVEN'] } } } },
        ],
      },
      select: { id: true, unitNumber: true },
      orderBy: { unitNumber: 'asc' },
    });
  }

  async status(buildingId: string, personId: string) {
    const manager = await this.currentManager(this.prisma, buildingId);
    if (!manager) return null;
    const poll = await this.prisma.chargeVerificationPoll.findUnique({
      where: { membershipId: manager.id },
      include: {
        draft: { select: { status: true, title: true, totalAmount: true } },
        ballots: { select: { unitId: true, approved: true } },
      },
    });
    if (!poll || poll.draft.status !== 'DRAFT') return null;
    const isManager = manager.personId === personId;
    const isMinutes = poll.requiredApprovals === 0;
    const units =
      !isMinutes && !poll.approvedAt
        ? await this.eligibleUnits(this.prisma, buildingId, personId)
        : [];
    const { firstName, lastName, fullName } = manager.person;
    return {
      id: poll.id,
      managerName: [firstName, lastName].filter(Boolean).join(' ') || fullName,
      mode: isMinutes ? 'MINUTES' : 'VOTE',
      approved: isMinutes
        ? await this.hasApprovedMinutes(this.prisma, manager.id)
        : !!poll.approvedAt,
      requiredApprovals: poll.requiredApprovals,
      approvals: poll.ballots.filter((ballot) => ballot.approved).length,
      units: units
        .filter((unit) => poll.unitIds.includes(unit.id))
        .map((unit) => ({
          ...unit,
          voted: poll.ballots.some((ballot) => ballot.unitId === unit.id),
        })),
      ...(isManager && {
        draftId: poll.draftId,
        draftTitle: poll.draft.title,
        draftAmount: poll.draft.totalAmount,
      }),
    };
  }

  async vote(
    buildingId: string,
    personId: string,
    pollId: string,
    unitId: string,
    approved: boolean,
    requestId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, buildingId);
      const manager = await this.currentManager(tx, buildingId);
      const poll = await tx.chargeVerificationPoll.findUnique({
        where: { id: pollId },
        include: { draft: { select: { status: true } } },
      });
      if (
        !manager ||
        !poll ||
        poll.membershipId !== manager.id ||
        poll.requiredApprovals === 0 ||
        poll.approvedAt ||
        poll.draft.status !== 'DRAFT'
      ) {
        throw new ConflictError('This verification poll is no longer open.');
      }
      const units = await this.eligibleUnits(tx, buildingId, personId);
      if (!poll.unitIds.includes(unitId) || !units.some((unit) => unit.id === unitId)) {
        throw new AuthorizationError('Only the current owner or tenant may vote for this unit.');
      }
      const inserted = await tx.chargeVerificationBallot.createMany({
        data: [{ pollId, unitId, voterId: personId, approved }],
        skipDuplicates: true,
      });
      if (!inserted.count) throw new ConflictError('This unit has already voted.');
      const approvals = await tx.chargeVerificationBallot.count({
        where: { pollId, approved: true },
      });
      if (approvals >= poll.requiredApprovals) {
        await tx.chargeVerificationPoll.update({
          where: { id: pollId },
          data: { approvedAt: new Date() },
        });
      }
      await tx.auditLog.create({
        data: {
          buildingId,
          actorId: personId,
          requestId,
          action: 'FirstChargeVerificationVoteCast',
          entityType: 'ChargeVerificationPoll',
          entityId: pollId,
          metadata: { unitId, approved, thresholdReached: approvals >= poll.requiredApprovals },
        },
      });
      return { recorded: true };
    });
  }
}
