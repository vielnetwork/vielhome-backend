import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { VotingService } from './voting.service';
import { VotingRepository } from '../infrastructure/repositories/voting.repository';
import { MeetingRepository } from '../infrastructure/repositories/meeting.repository';
import { VoteProxyRepository } from '../infrastructure/repositories/vote-proxy.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { BuildingService } from '../../building/application/building.service';
import { VotePolicy } from '../domain/policies/vote.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { DuplicateError } from '../../../common/errors/app-error';

/**
 * Governance Hardening Phase 1 — `VotingService` unit tests.
 *
 * The Governance audit's own §31/§50 finding: this service had zero
 * unit-level coverage before this pass — only `domain/policies/*.spec.ts`
 * (pure logic, no I/O) and the full e2e suite ever exercised it. This file
 * is narrowly scoped to `castBallot`'s duplicate-vote handling (the
 * concurrency fix this hardening pass exists to add regression coverage
 * for), not a full `VotingService` test suite — broader service-level
 * coverage is tracked separately (audit §"Medium-priority issues" #9).
 *
 * `VotingRepository`/`MeetingRepository`/`VoteProxyRepository`/
 * `BuildingRepository`/`BuildingService`/`AuditService`/`EventEmitter2` are
 * fully mocked (I/O isolation, same discipline `finance.service.spec.ts`
 * already established). `VotePolicy` is a real, un-mocked instance — it
 * has no dependencies of its own, is already exhaustively unit-tested in
 * `vote.policy.spec.ts`, and using the real object here proves the service
 * actually wires its real behavior end-to-end.
 */
describe('VotingService', () => {
  let voting: Record<string, jest.Mock>;
  let meetings: Record<string, jest.Mock>;
  let voteProxies: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let buildingService: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let service: VotingService;

  const VOTE = {
    id: 'vote-1',
    buildingId: 'b1',
    status: 'ACTIVE',
    endAt: new Date(Date.now() + 60 * 60 * 1000),
    isManagerElection: false,
    options: [
      { id: 'opt-yes', value: 'YES' },
      { id: 'opt-no', value: 'NO' },
    ],
  };
  const UNIT = { id: 'unit-1', buildingId: 'b1' };
  const SNAPSHOT = { voteId: 'vote-1', unitId: 'unit-1', eligiblePersonId: 'person-1' };
  const DTO = { unitId: 'unit-1', selectedOptionId: 'opt-yes' };

  beforeEach(() => {
    voting = {
      findVoteById: jest.fn().mockResolvedValue(VOTE),
      findEligibilitySnapshotForUnit: jest.fn().mockResolvedValue(SNAPSHOT),
      findBallotForUnit: jest.fn().mockResolvedValue(null),
      createBallot: jest.fn(),
      createVote: jest.fn().mockResolvedValue({ id: 'vote-1' }),
      publishVote: jest.fn().mockResolvedValue({ id: 'vote-1', status: 'ACTIVE' }),
      closeVote: jest.fn().mockResolvedValue({
        vote: { id: 'vote-1', status: 'CLOSED' },
        result: {
          resultStatus: 'PASSED',
          totalEligibleCount: 2,
          totalBallotCount: 2,
          quorumMet: true,
          winningOptionId: 'opt-yes',
        },
      }),
      cancelVote: jest.fn().mockResolvedValue({ id: 'vote-1', status: 'CANCELLED' }),
    };
    meetings = {};
    voteProxies = { isCurrentProxyFor: jest.fn().mockResolvedValue(false) };
    buildings = {
      findById: jest.fn().mockResolvedValue({ id: 'b1' }),
      findUnitById: jest.fn().mockResolvedValue(UNIT),
      getBuildingSettings: jest.fn().mockResolvedValue({ allowTenantVoting: false }),
    };
    buildingService = { changeManager: jest.fn() };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };

    service = new VotingService(
      voting as unknown as VotingRepository,
      meetings as unknown as MeetingRepository,
      voteProxies as unknown as VoteProxyRepository,
      buildings as unknown as BuildingRepository,
      buildingService as unknown as BuildingService,
      new VotePolicy(),
      audit as unknown as AuditService,
      events as unknown as EventEmitter2,
    );
  });

  describe('castBallot', () => {
    it("casts a ballot for the unit's direct eligible voter", async () => {
      voting.createBallot.mockResolvedValue({
        id: 'ballot-1',
        voteId: 'vote-1',
        unitId: 'unit-1',
        voterPersonId: 'person-1',
        selectedOptionId: 'opt-yes',
      });

      const result = await service.castBallot('b1', 'vote-1', DTO, 'person-1', 'req-1');

      expect(result).toEqual(
        expect.objectContaining({ id: 'ballot-1', voterPersonId: 'person-1' }),
      );
      expect(events.emit).toHaveBeenCalledWith('BallotCast', expect.anything());
    });

    it('rejects a sequential duplicate ballot (existing row found by the pre-check)', async () => {
      voting.findBallotForUnit.mockResolvedValue({ id: 'existing-ballot' });

      await expect(
        service.castBallot('b1', 'vote-1', DTO, 'person-1', 'req-1'),
      ).rejects.toBeInstanceOf(DuplicateError);
      expect(voting.createBallot).not.toHaveBeenCalled();
    });

    it('converts a concurrent P2002 unique-constraint race into a clean DuplicateError, not an unhandled 500', async () => {
      // Governance Hardening Phase 1 (audit §31) — two near-simultaneous
      // castBallot calls for the same (voteId, unitId) can both pass the
      // findBallotForUnit pre-check above before either write lands; the
      // loser's createBallot hits Ballot's own @@unique([voteId, unitId])
      // constraint. Before this fix, that raw PrismaClientKnownRequestError
      // propagated uncaught and AllExceptionsFilter's catch-all turned it
      // into an opaque 500 UNEXPECTED_ERROR instead of the same clean
      // DuplicateError a sequential duplicate already gets.
      const raceError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
      raceError.code = 'P2002';
      voting.createBallot.mockRejectedValue(raceError);

      await expect(
        service.castBallot('b1', 'vote-1', DTO, 'person-1', 'req-1'),
      ).rejects.toBeInstanceOf(DuplicateError);
    });

    it('re-throws a non-P2002 error from createBallot unchanged', async () => {
      const otherError = new Error('some other failure');
      voting.createBallot.mockRejectedValue(otherError);

      await expect(service.castBallot('b1', 'vote-1', DTO, 'person-1', 'req-1')).rejects.toBe(
        otherError,
      );
    });
  });

  /**
   * Governance Staff Admin Backend Enablement — `actorContext` regression
   * coverage: every mutating method defaults to `'MEMBER'` (so the
   * existing member-facing `VotingController` needs zero changes) and
   * forwards whatever it's given into the audit metadata, so a future
   * staff-admin caller's audit trail is distinguishable from a
   * building-member's.
   */
  describe('actorContext propagation', () => {
    it('createVote defaults to MEMBER when omitted', async () => {
      await service.createVote(
        'b1',
        {
          title: 't',
          category: 'MANAGEMENT',
          startAt: new Date(Date.now() + 1000).toISOString(),
          endAt: new Date(Date.now() + 100000).toISOString(),
        } as never,
        'person-1',
        'req-1',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ actorContext: 'MEMBER' }) }),
      );
    });

    it('createVote forwards an explicit PLATFORM_STAFF actorContext into the audit metadata', async () => {
      await service.createVote(
        'b1',
        {
          title: 't',
          category: 'MANAGEMENT',
          startAt: new Date(Date.now() + 1000).toISOString(),
          endAt: new Date(Date.now() + 100000).toISOString(),
        } as never,
        'staff-person-1',
        'req-1',
        'PLATFORM_STAFF',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'staff-person-1',
          metadata: expect.objectContaining({ actorContext: 'PLATFORM_STAFF' }),
        }),
      );
    });

    it('publishVote forwards actorContext into the audit metadata', async () => {
      voting.findVoteById.mockResolvedValue({ ...VOTE, status: 'DRAFT' });
      await service.publishVote('b1', 'vote-1', 'staff-person-1', 'req-1', 'PLATFORM_STAFF');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { actorContext: 'PLATFORM_STAFF' } }),
      );
    });

    it('closeVote reads the tally from the repository-returned result (not recomputed here) and forwards actorContext', async () => {
      const { result } = await service.closeVote(
        'b1',
        'vote-1',
        'staff-person-1',
        'req-1',
        'PLATFORM_STAFF',
      );
      expect(voting.closeVote).toHaveBeenCalledWith('vote-1', undefined);
      expect(result.winningOptionId).toBe('opt-yes');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            resultStatus: 'PASSED',
            actorContext: 'PLATFORM_STAFF',
          }),
        }),
      );
    });

    it('closeVote propagates a ConflictError from the repository CAS unchanged', async () => {
      const { ConflictError } = await import('../../../common/errors/app-error');
      voting.closeVote.mockRejectedValue(new ConflictError('stale'));
      await expect(service.closeVote('b1', 'vote-1', 'person-1', 'req-1')).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('cancelVote passes the freshly-read vote status as the CAS expectedStatus and forwards actorContext', async () => {
      await service.cancelVote(
        'b1',
        'vote-1',
        { reason: 'no longer needed' },
        'staff-person-1',
        'req-1',
        'PLATFORM_STAFF',
      );
      expect(voting.cancelVote).toHaveBeenCalledWith('vote-1', VOTE.status, 'no longer needed');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { actorContext: 'PLATFORM_STAFF' } }),
      );
    });

    it('cancelVote propagates a ConflictError from the repository CAS unchanged', async () => {
      const { ConflictError } = await import('../../../common/errors/app-error');
      voting.cancelVote.mockRejectedValue(new ConflictError('stale'));
      await expect(
        service.cancelVote('b1', 'vote-1', {}, 'person-1', 'req-1'),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});
