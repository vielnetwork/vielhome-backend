import { MeetingRepository } from './meeting.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * Governance Hardening Phase 3 — `MeetingRepository` unit tests.
 *
 * Narrowly scoped to the two non-trivial pieces of logic in this
 * repository: Phase 2's pagination (`listByBuilding`/`listAttendance` —
 * `count` alongside `findMany`, `skip`/`take` passed through, correct
 * `orderBy`) and `recordAttendance`'s bulk-idempotent
 * `createMany({ skipDuplicates: true })` + refetch pattern (04.06 Rule
 * 12). Every other method here is a one-line Prisma pass-through with no
 * branching worth a dedicated unit test on its own.
 */
describe('MeetingRepository', () => {
  let prisma: {
    meeting: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; update: jest.Mock };
    meetingAttendance: { createMany: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  };
  let repository: MeetingRepository;

  beforeEach(() => {
    prisma = {
      meeting: {
        create: jest.fn().mockResolvedValue({ id: 'meeting-1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'meeting-1' }]),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({ id: 'meeting-1', archivedAt: new Date() }),
      },
      meetingAttendance: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ meetingId: 'meeting-1', personId: 'p1' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    repository = new MeetingRepository(prisma as unknown as PrismaService);
  });

  describe('listByBuilding', () => {
    it('runs count alongside findMany, ordered by scheduledAt desc, with skip/take passed through', async () => {
      const result = await repository.listByBuilding('b1', { skip: 2, take: 5 });

      expect(prisma.meeting.findMany).toHaveBeenCalledWith({
        where: { buildingId: 'b1' },
        orderBy: { scheduledAt: 'desc' },
        skip: 2,
        take: 5,
      });
      expect(prisma.meeting.count).toHaveBeenCalledWith({ where: { buildingId: 'b1' } });
      expect(result).toEqual({ items: [{ id: 'meeting-1' }], total: 1 });
    });
  });

  describe('listAttendance', () => {
    it('runs count alongside findMany, ordered by recordedAt desc, with skip/take passed through', async () => {
      const result = await repository.listAttendance('meeting-1', { skip: 1, take: 1 });

      expect(prisma.meetingAttendance.findMany).toHaveBeenCalledWith({
        where: { meetingId: 'meeting-1' },
        orderBy: { recordedAt: 'desc' },
        skip: 1,
        take: 1,
      });
      expect(prisma.meetingAttendance.count).toHaveBeenCalledWith({ where: { meetingId: 'meeting-1' } });
      expect(result).toEqual({ items: [{ meetingId: 'meeting-1', personId: 'p1' }], total: 1 });
    });
  });

  describe('recordAttendance', () => {
    it('bulk-creates with skipDuplicates, then refetches the full attendance list for the meeting', async () => {
      const result = await repository.recordAttendance('meeting-1', ['p1', 'p2']);

      expect(prisma.meetingAttendance.createMany).toHaveBeenCalledWith({
        data: [
          { meetingId: 'meeting-1', personId: 'p1' },
          { meetingId: 'meeting-1', personId: 'p2' },
        ],
        skipDuplicates: true,
      });
      expect(prisma.meetingAttendance.findMany).toHaveBeenCalledWith({ where: { meetingId: 'meeting-1' } });
      expect(result).toEqual([{ meetingId: 'meeting-1', personId: 'p1' }]);
    });
  });

  describe('archiveMeeting', () => {
    it('sets archivedAt to a real timestamp', async () => {
      await repository.archiveMeeting('meeting-1');

      expect(prisma.meeting.update).toHaveBeenCalledWith({
        where: { id: 'meeting-1' },
        data: { archivedAt: expect.any(Date) },
      });
    });
  });
});
