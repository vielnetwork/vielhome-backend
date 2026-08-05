import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';

@Injectable()
export class MeetingRepository {
  constructor(private readonly prisma: PrismaService) {}

  createMeeting(params: {
    buildingId: string;
    title: string;
    scheduledAt: Date;
    location?: string;
    createdById: string;
  }) {
    return this.prisma.meeting.create({
      data: {
        buildingId: params.buildingId,
        title: params.title,
        scheduledAt: params.scheduledAt,
        location: params.location,
        createdById: params.createdById,
      },
    });
  }

  findById(id: string) {
    return this.prisma.meeting.findUnique({
      where: { id },
      include: { attendances: true, votes: true },
    });
  }

  /**
   * Governance Hardening Phase 2 (audit §44) — paginated, same convention
   * as `VotingRepository.listVotes`/`FinanceRepository.listFunds`
   * (`common/pagination/pagination.util.ts`, ADR-072/ADR-120).
   */
  async listByBuilding(buildingId: string, pagination: { skip: number; take: number }) {
    const where = { buildingId };
    const [items, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.meeting.count({ where }),
    ]);
    return { items, total };
  }

  updateMeeting(
    id: string,
    data: { title?: string; scheduledAt?: Date; location?: string; minutes?: string },
  ) {
    return this.prisma.meeting.update({ where: { id }, data });
  }

  /** 04.06 Rule 13 — one-way; there is deliberately no "un-archive" method. */
  archiveMeeting(id: string) {
    return this.prisma.meeting.update({ where: { id }, data: { archivedAt: new Date() } });
  }

  /**
   * 04.06 Rule 12 — bulk-records attendance, skipping any (meeting, person)
   * pair already recorded (the unique constraint's application-side
   * counterpart) so recording attendance is safely repeatable.
   */
  async recordAttendance(meetingId: string, personIds: string[]) {
    await this.prisma.meetingAttendance.createMany({
      data: personIds.map((personId) => ({ meetingId, personId })),
      skipDuplicates: true,
    });
    return this.prisma.meetingAttendance.findMany({ where: { meetingId } });
  }

  /**
   * Governance Hardening Phase 2 (audit §44) — paginated, same convention
   * as this file's own `listByBuilding` above. Ordered by `recordedAt`
   * descending (most recently recorded first) — `MeetingAttendance` has no
   * `createdAt` field of its own; `recordedAt` is its equivalent.
   */
  async listAttendance(meetingId: string, pagination: { skip: number; take: number }) {
    const where = { meetingId };
    const [items, total] = await Promise.all([
      this.prisma.meetingAttendance.findMany({
        where,
        orderBy: { recordedAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.meetingAttendance.count({ where }),
    ]);
    return { items, total };
  }
}
