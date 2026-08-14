import { VotingRepository } from './voting.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { VotePolicy } from '../../domain/policies/vote.policy';
import { BusinessRuleViolationError, ConflictError } from '../../../../common/errors/app-error';

/**
 * Governance Hardening Phase 3 — `VotingRepository` unit tests.
 *
 * Narrowly scoped to `publishVote`'s own real branching logic (audit
 * §10/§17/§44's own findings): the `ADR-058` scope-filter construction
 * (`BLOCK`/`PROPERTY_TYPE`/`SELECTED_UNITS`/`ENTIRE_BUILDING`) and the
 * `ADR-089` owner-vs-tenant eligibility resolution — both were previously
 * verified only by reading the code and by the full e2e suite (Phase 2's
 * new BLOCK/PROPERTY_TYPE describe, and the pre-existing Tenant Voting
 * Eligibility describe from Phase 1), never in isolation. `$transaction`
 * is mocked to synchronously invoke its callback with a fake `tx` —
 * exercises `publishVote`'s own logic directly, not Postgres itself
 * (which the e2e suite already covers against a real database).
 */
describe('VotingRepository', () => {
  describe('publishVote', () => {
    let tx: {
      vote: { update: jest.Mock };
      unit: { findMany: jest.Mock };
      voteEligibilitySnapshot: { createMany: jest.Mock };
    };
    let transactionMock: jest.Mock;
    let repository: VotingRepository;

    function setup(voteOverrides: Record<string, unknown> = {}) {
      tx = {
        vote: {
          update: jest.fn().mockResolvedValue({
            id: 'vote-1',
            scopeType: 'ENTIRE_BUILDING',
            scopeBlockId: null,
            scopeUnitType: null,
            scopeUnitIds: [],
            ...voteOverrides,
          }),
        },
        unit: { findMany: jest.fn().mockResolvedValue([]) },
        voteEligibilitySnapshot: { createMany: jest.fn() },
      };
      transactionMock = jest.fn((callback: (tx: unknown) => unknown) => callback(tx));
      repository = new VotingRepository(
        { $transaction: transactionMock } as unknown as PrismaService,
        new VotePolicy(),
      );
    }

    it('ENTIRE_BUILDING (the default) applies no unit-scope filter beyond buildingId', async () => {
      setup();
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.unit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1' } }),
      );
    });

    it('BLOCK scope filters units by blockId', async () => {
      setup({ scopeType: 'BLOCK', scopeBlockId: 'block-1' });
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.unit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1', blockId: 'block-1' } }),
      );
    });

    it('PROPERTY_TYPE scope filters units by type', async () => {
      setup({ scopeType: 'PROPERTY_TYPE', scopeUnitType: 'COMMERCIAL' });
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.unit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1', type: 'COMMERCIAL' } }),
      );
    });

    it('SELECTED_UNITS scope filters units by id-in-list', async () => {
      setup({ scopeType: 'SELECTED_UNITS', scopeUnitIds: ['u1', 'u2'] });
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.unit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buildingId: 'b1', id: { in: ['u1', 'u2'] } } }),
      );
    });

    it('owner-only mode (allowTenantVoting=false) captures the single current owner, ignoring any tenant', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([
        { id: 'u1', ownerships: [{ personId: 'owner-1' }], tenancies: [{ personId: 'tenant-1' }] },
      ]);
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.voteEligibilitySnapshot.createMany).toHaveBeenCalledWith({
        data: [
          { voteId: 'vote-1', unitId: 'u1', eligiblePersonId: 'owner-1', eligibilityType: 'OWNER' },
        ],
      });
    });

    it('allowTenantVoting=true hands eligibility to the sole current tenant instead of the owner', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([
        { id: 'u1', ownerships: [{ personId: 'owner-1' }], tenancies: [{ personId: 'tenant-1' }] },
      ]);
      await repository.publishVote('vote-1', 'b1', true);
      expect(tx.voteEligibilitySnapshot.createMany).toHaveBeenCalledWith({
        data: [
          {
            voteId: 'vote-1',
            unitId: 'u1',
            eligiblePersonId: 'tenant-1',
            eligibilityType: 'TENANT',
          },
        ],
      });
    });

    it('allowTenantVoting=true falls back to the owner rule when the unit has zero current tenants', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([
        { id: 'u1', ownerships: [{ personId: 'owner-1' }], tenancies: [] },
      ]);
      await repository.publishVote('vote-1', 'b1', true);
      expect(tx.voteEligibilitySnapshot.createMany).toHaveBeenCalledWith({
        data: [
          { voteId: 'vote-1', unitId: 'u1', eligiblePersonId: 'owner-1', eligibilityType: 'OWNER' },
        ],
      });
    });

    it('excludes a unit with zero or multiple current owners (and no qualifying tenant) from the snapshot entirely', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([
        { id: 'no-owner', ownerships: [], tenancies: [] },
        {
          id: 'co-owned',
          ownerships: [{ personId: 'a' }, { personId: 'b' }],
          tenancies: [],
        },
      ]);
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.voteEligibilitySnapshot.createMany).not.toHaveBeenCalled();
    });

    it('skips the createMany call entirely (not just an empty data array) when no unit is eligible', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([{ id: 'no-owner', ownerships: [], tenancies: [] }]);
      await repository.publishVote('vote-1', 'b1', false);
      expect(tx.voteEligibilitySnapshot.createMany).not.toHaveBeenCalled();
    });
  });

  /**
   * Governance Staff Admin Backend Enablement — concurrency hardening
   * regression coverage. `$transaction` is mocked the same way
   * `publishVote`'s own describe block above already does (synchronously
   * invoke the callback with a fake `tx`), proving `closeVote`/
   * `cancelVote`/`createBallot` each perform their CAS/re-check
   * correctly, independent of a real Postgres connection (the full e2e
   * suite is the only thing that can prove the real row-visibility
   * behavior these rely on — not runnable in this environment, see the
   * phase report).
   */
  describe('closeVote', () => {
    function setup(overrides: { claimedCount?: number } = {}) {
      const tx = {
        vote: {
          updateMany: jest.fn().mockResolvedValue({ count: overrides.claimedCount ?? 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'vote-1', status: 'CLOSED' }),
        },
        voteEligibilitySnapshot: {
          findMany: jest.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
        },
        ballot: {
          findMany: jest.fn().mockResolvedValue([
            { selectedOptionId: 'opt-yes', selectedOption: { value: 'YES' } },
            { selectedOptionId: 'opt-yes', selectedOption: { value: 'YES' } },
          ]),
        },
        voteResult: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
      };
      const transactionMock = jest.fn((callback: (tx: unknown) => unknown) => callback(tx));
      const repository = new VotingRepository(
        { $transaction: transactionMock } as unknown as PrismaService,
        new VotePolicy(),
      );
      return { tx, repository };
    }

    it('atomically transitions ACTIVE -> CLOSED and writes a computed VoteResult', async () => {
      const { tx, repository } = setup();
      const { result } = await repository.closeVote('vote-1', null);
      expect(tx.vote.updateMany).toHaveBeenCalledWith({
        where: { id: 'vote-1', status: 'ACTIVE' },
        data: { status: 'CLOSED', closedAt: expect.any(Date) },
      });
      expect(result.winningOptionId).toBe('opt-yes');
      expect(result.resultStatus).toBe('PASSED');
      expect(result.totalEligibleCount).toBe(2);
      expect(result.totalBallotCount).toBe(2);
    });

    it('reads ballots/snapshots from inside the same transaction as the status CAS, not a pre-transaction snapshot', async () => {
      const { tx, repository } = setup();
      await repository.closeVote('vote-1', null);
      expect(tx.ballot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { voteId: 'vote-1' } }),
      );
      expect(tx.voteEligibilitySnapshot.findMany).toHaveBeenCalledWith({
        where: { voteId: 'vote-1' },
      });
    });

    it('throws ConflictError and never computes/writes a result when the CAS loses the race (vote no longer ACTIVE)', async () => {
      const { tx, repository } = setup({ claimedCount: 0 });
      await expect(repository.closeVote('vote-1', null)).rejects.toBeInstanceOf(ConflictError);
      expect(tx.ballot.findMany).not.toHaveBeenCalled();
      expect(tx.voteResult.create).not.toHaveBeenCalled();
    });
  });

  describe('cancelVote', () => {
    it('CASes against the expected prior status and returns the cancelled vote on success', async () => {
      const prisma = {
        vote: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'vote-1', status: 'CANCELLED' }),
        },
      };
      const repository = new VotingRepository(prisma as unknown as PrismaService, new VotePolicy());
      await repository.cancelVote('vote-1', 'ACTIVE', 'no longer needed');
      expect(prisma.vote.updateMany).toHaveBeenCalledWith({
        where: { id: 'vote-1', status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          cancelledAt: expect.any(Date),
          cancelReason: 'no longer needed',
        },
      });
    });

    it('throws ConflictError when the vote status has already moved on (e.g. a simultaneous close won the race)', async () => {
      const prisma = {
        vote: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      };
      const repository = new VotingRepository(prisma as unknown as PrismaService, new VotePolicy());
      await expect(repository.cancelVote('vote-1', 'ACTIVE')).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('createBallot', () => {
    function setup(voteOverrides: Record<string, unknown> | null) {
      const tx = {
        vote: { findUnique: jest.fn().mockResolvedValue(voteOverrides) },
        ballot: { create: jest.fn().mockResolvedValue({ id: 'ballot-1' }) },
      };
      const transactionMock = jest.fn((callback: (tx: unknown) => unknown) => callback(tx));
      const repository = new VotingRepository(
        { $transaction: transactionMock } as unknown as PrismaService,
        new VotePolicy(),
      );
      return { tx, repository };
    }
    const PARAMS = {
      voteId: 'vote-1',
      unitId: 'unit-1',
      voterPersonId: 'person-1',
      selectedOptionId: 'opt-yes',
    };

    it('creates the ballot when the same-transaction re-check finds the vote still ACTIVE and within its window', async () => {
      const { tx, repository } = setup({
        status: 'ACTIVE',
        endAt: new Date(Date.now() + 60_000),
      });
      await repository.createBallot(PARAMS);
      expect(tx.ballot.create).toHaveBeenCalledWith({ data: PARAMS });
    });

    it('rejects with BusinessRuleViolationError instead of inserting when the vote closed in the gap (re-check sees non-ACTIVE)', async () => {
      const { tx, repository } = setup({ status: 'CLOSED', endAt: new Date(Date.now() + 60_000) });
      await expect(repository.createBallot(PARAMS)).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
      expect(tx.ballot.create).not.toHaveBeenCalled();
    });

    it('rejects when the re-check finds the voting window has since closed', async () => {
      const { tx, repository } = setup({ status: 'ACTIVE', endAt: new Date(Date.now() - 1_000) });
      await expect(repository.createBallot(PARAMS)).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
      expect(tx.ballot.create).not.toHaveBeenCalled();
    });

    it('rejects when the vote no longer exists', async () => {
      const { tx, repository } = setup(null);
      await expect(repository.createBallot(PARAMS)).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
      expect(tx.ballot.create).not.toHaveBeenCalled();
    });
  });
});
