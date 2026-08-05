import { EventEmitter2 } from '@nestjs/event-emitter';
import { MeetingService } from './meeting.service';
import { MeetingRepository } from '../infrastructure/repositories/meeting.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { MeetingPolicy } from '../domain/policies/meeting.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { BusinessRuleViolationError, NotFoundAppError } from '../../../common/errors/app-error';

/**
 * Governance Hardening Phase 3 — `MeetingService` unit tests.
 *
 * The Governance audit's own §50 finding: this service had zero unit-level
 * coverage before this pass, same gap `voting.service.spec.ts` closed for
 * `VotingService` in Phase 1. `MeetingRepository`/`BuildingRepository`/
 * `AuditService`/`EventEmitter2` are fully mocked; `MeetingPolicy` is a
 * real, un-mocked instance (no dependencies of its own, already
 * exhaustively covered in `meeting.policy.spec.ts`).
 */
describe('MeetingService', () => {
  let meetings: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let service: MeetingService;

  const OPEN_MEETING = {
    id: 'meeting-1',
    buildingId: 'b1',
    title: 'Board Meeting',
    archivedAt: null,
  };
  const ARCHIVED_MEETING = { ...OPEN_MEETING, id: 'meeting-2', archivedAt: new Date() };

  beforeEach(() => {
    meetings = {
      createMeeting: jest.fn().mockResolvedValue(OPEN_MEETING),
      findById: jest.fn().mockResolvedValue(OPEN_MEETING),
      listByBuilding: jest.fn().mockResolvedValue({ items: [OPEN_MEETING], total: 1 }),
      updateMeeting: jest.fn().mockResolvedValue({ ...OPEN_MEETING, minutes: 'updated' }),
      archiveMeeting: jest.fn().mockResolvedValue({ ...OPEN_MEETING, archivedAt: new Date() }),
      recordAttendance: jest.fn().mockResolvedValue([{ meetingId: 'meeting-1', personId: 'p1' }]),
      listAttendance: jest
        .fn()
        .mockResolvedValue({ items: [{ meetingId: 'meeting-1', personId: 'p1' }], total: 1 }),
    };
    buildings = { findById: jest.fn().mockResolvedValue({ id: 'b1' }) };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };

    service = new MeetingService(
      meetings as unknown as MeetingRepository,
      buildings as unknown as BuildingRepository,
      new MeetingPolicy(),
      audit as unknown as AuditService,
      events as unknown as EventEmitter2,
    );
  });

  describe('createMeeting', () => {
    it('creates a meeting, audits it, and emits MeetingCreated', async () => {
      const result = await service.createMeeting(
        'b1',
        { title: 'Board Meeting', scheduledAt: new Date().toISOString() },
        'person-1',
        'req-1',
      );

      expect(result).toEqual(OPEN_MEETING);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MeetingCreated', entityId: 'meeting-1' }),
      );
      expect(events.emit).toHaveBeenCalledWith('MeetingCreated', expect.anything());
    });

    it('404s when the building does not exist', async () => {
      buildings.findById.mockResolvedValue(null);

      await expect(
        service.createMeeting('missing-b', { title: 'x', scheduledAt: new Date().toISOString() }, 'p1', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('listMeetings / listAttendance — pagination pass-through', () => {
    it('listMeetings converts pagination and returns items + meta', async () => {
      const result = await service.listMeetings('b1', { page: 1, limit: 20 });

      expect(meetings.listByBuilding).toHaveBeenCalledWith('b1', { skip: 0, take: 20 });
      expect(result).toEqual({
        items: [OPEN_MEETING],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });
    });

    it('listAttendance double-checks the meeting belongs to the building before paginating', async () => {
      const result = await service.listAttendance('b1', 'meeting-1', { page: 2, limit: 1 });

      expect(meetings.findById).toHaveBeenCalledWith('meeting-1');
      expect(meetings.listAttendance).toHaveBeenCalledWith('meeting-1', { skip: 1, take: 1 });
      expect(result.meta).toEqual({ page: 2, limit: 1, total: 1, totalPages: 1 });
    });

    it('listAttendance 404s when the meeting belongs to another building', async () => {
      meetings.findById.mockResolvedValue({ ...OPEN_MEETING, buildingId: 'other-building' });

      await expect(
        service.listAttendance('b1', 'meeting-1', { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('updateMeeting', () => {
    it('updates an open meeting', async () => {
      const result = await service.updateMeeting(
        'b1',
        'meeting-1',
        { minutes: 'updated' },
        'person-1',
        'req-1',
      );

      expect(result.minutes).toBe('updated');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'MeetingUpdated' }));
    });

    it('rejects updating an archived meeting', async () => {
      meetings.findById.mockResolvedValue(ARCHIVED_MEETING);

      await expect(
        service.updateMeeting('b1', 'meeting-2', { minutes: 'x' }, 'person-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(meetings.updateMeeting).not.toHaveBeenCalled();
    });
  });

  describe('archiveMeeting', () => {
    it('archives an open meeting, audits it, and emits MeetingArchived', async () => {
      const result = await service.archiveMeeting('b1', 'meeting-1', 'person-1', 'req-1');

      expect(result.archivedAt).not.toBeNull();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'MeetingArchived' }));
      expect(events.emit).toHaveBeenCalledWith('MeetingArchived', expect.anything());
    });

    it('rejects archiving an already-archived meeting', async () => {
      meetings.findById.mockResolvedValue(ARCHIVED_MEETING);

      await expect(
        service.archiveMeeting('b1', 'meeting-2', 'person-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(meetings.archiveMeeting).not.toHaveBeenCalled();
    });
  });

  describe('recordAttendance', () => {
    it('records attendance for an open meeting', async () => {
      const result = await service.recordAttendance(
        'b1',
        'meeting-1',
        { personIds: ['p1'] },
        'person-1',
        'req-1',
      );

      expect(result).toHaveLength(1);
      expect(meetings.recordAttendance).toHaveBeenCalledWith('meeting-1', ['p1']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MeetingAttendanceRecorded' }),
      );
      // Governance Hardening Phase 3 (audit §25) — deliberately no
      // notification event for attendance; see `meeting.events.ts`'s own
      // doc comment for why.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('rejects recording attendance on an archived meeting', async () => {
      meetings.findById.mockResolvedValue(ARCHIVED_MEETING);

      await expect(
        service.recordAttendance('b1', 'meeting-2', { personIds: ['p1'] }, 'person-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(meetings.recordAttendance).not.toHaveBeenCalled();
    });
  });
});
