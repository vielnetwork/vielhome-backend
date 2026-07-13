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

  listByBuilding(buildingId: string) {
    return this.prisma.meeting.findMany({
      where: { buildingId },
      orderBy: { scheduledAt: 'desc' },
    });
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

  listAttendance(meetingId: string) {
    return this.prisma.meetingAttendance.findMany({ where: { meetingId } });
  }
}
