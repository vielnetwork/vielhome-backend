import { Injectable } from '@nestjs/common';
import { MeetingRepository } from '../infrastructure/repositories/meeting.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { MeetingPolicy } from '../domain/policies/meeting.policy';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { UpdateMeetingDto } from './dto/update-meeting.dto';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * Governance / Meetings (04.06_Governance_Rules Rules 11-13, 20 — see
 * 21_ADRs > ADR-049, deferred since ADR-024's Governance MVP). A Meeting is
 * a distinct entity from Vote (Rule 11) — it may have zero, one, or many
 * linked votes; nothing here changes how a vote is created or run.
 */
@Injectable()
export class MeetingService {
  constructor(
    private readonly meetings: MeetingRepository,
    private readonly buildings: BuildingRepository,
    private readonly policy: MeetingPolicy,
    private readonly audit: AuditService,
  ) {}

  private async getBuilding(buildingId: string) {
    const building = await this.buildings.findById(buildingId);
    if (!building) throw new NotFoundAppError('Building not found.');
    return building;
  }

  /** Double-checks the meeting belongs to the building in the URL — same pattern as `VotingService.getVote`/`CasesService.getCaseOrThrow`. */
  private async getMeetingOrThrow(buildingId: string, meetingId: string) {
    const meeting = await this.meetings.findById(meetingId);
    if (!meeting || meeting.buildingId !== buildingId) {
      throw new NotFoundAppError('Meeting not found.');
    }
    return meeting;
  }

  async createMeeting(
    buildingId: string,
    dto: CreateMeetingDto,
    actorPersonId: string,
    requestId: string,
  ) {
    await this.getBuilding(buildingId);

    const meeting = await this.meetings.createMeeting({
      buildingId,
      title: dto.title,
      scheduledAt: new Date(dto.scheduledAt),
      location: dto.location,
      createdById: actorPersonId,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'MeetingCreated',
      entityType: 'Meeting',
      entityId: meeting.id,
      requestId,
    });

    return meeting;
  }

  listMeetings(buildingId: string) {
    return this.meetings.listByBuilding(buildingId);
  }

  getMeeting(buildingId: string, meetingId: string) {
    return this.getMeetingOrThrow(buildingId, meetingId);
  }

  async updateMeeting(
    buildingId: string,
    meetingId: string,
    dto: UpdateMeetingDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const meeting = await this.getMeetingOrThrow(buildingId, meetingId);
    this.policy.assertNotArchived(meeting.archivedAt);

    const updated = await this.meetings.updateMeeting(meetingId, {
      title: dto.title,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      location: dto.location,
      minutes: dto.minutes,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'MeetingUpdated',
      entityType: 'Meeting',
      entityId: meetingId,
      requestId,
    });

    return updated;
  }

  /** 04.06 Rule 13 — one-way; an archived meeting's record (including its minutes) is preserved as-is going forward. */
  async archiveMeeting(
    buildingId: string,
    meetingId: string,
    actorPersonId: string,
    requestId: string,
  ) {
    const meeting = await this.getMeetingOrThrow(buildingId, meetingId);
    this.policy.assertArchivable(meeting.archivedAt);

    const updated = await this.meetings.archiveMeeting(meetingId);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'MeetingArchived',
      entityType: 'Meeting',
      entityId: meetingId,
      requestId,
    });

    return updated;
  }

  /** 04.06 Rule 12 — records attendance for a batch of Persons; blocked once the meeting is archived, same as any other update. */
  async recordAttendance(
    buildingId: string,
    meetingId: string,
    dto: RecordAttendanceDto,
    actorPersonId: string,
    requestId: string,
  ) {
    const meeting = await this.getMeetingOrThrow(buildingId, meetingId);
    this.policy.assertNotArchived(meeting.archivedAt);

    const attendances = await this.meetings.recordAttendance(meetingId, dto.personIds);

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'MeetingAttendanceRecorded',
      entityType: 'Meeting',
      entityId: meetingId,
      requestId,
      metadata: { personIds: dto.personIds },
    });

    return attendances;
  }

  async listAttendance(buildingId: string, meetingId: string) {
    await this.getMeetingOrThrow(buildingId, meetingId);
    return this.meetings.listAttendance(meetingId);
  }
}
