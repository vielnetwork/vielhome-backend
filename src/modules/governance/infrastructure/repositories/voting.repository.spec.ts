import { VotingRepository } from './voting.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

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
      repository = new VotingRepository({
        $transaction: transactionMock,
      } as unknown as PrismaService);
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
        data: [{ voteId: 'vote-1', unitId: 'u1', eligiblePersonId: 'owner-1', eligibilityType: 'OWNER' }],
      });
    });

    it('allowTenantVoting=true hands eligibility to the sole current tenant instead of the owner', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([
        { id: 'u1', ownerships: [{ personId: 'owner-1' }], tenancies: [{ personId: 'tenant-1' }] },
      ]);
      await repository.publishVote('vote-1', 'b1', true);
      expect(tx.voteEligibilitySnapshot.createMany).toHaveBeenCalledWith({
        data: [{ voteId: 'vote-1', unitId: 'u1', eligiblePersonId: 'tenant-1', eligibilityType: 'TENANT' }],
      });
    });

    it('allowTenantVoting=true falls back to the owner rule when the unit has zero current tenants', async () => {
      setup();
      tx.unit.findMany.mockResolvedValue([
        { id: 'u1', ownerships: [{ personId: 'owner-1' }], tenancies: [] },
      ]);
      await repository.publishVote('vote-1', 'b1', true);
      expect(tx.voteEligibilitySnapshot.createMany).toHaveBeenCalledWith({
        data: [{ voteId: 'vote-1', unitId: 'u1', eligiblePersonId: 'owner-1', eligibilityType: 'OWNER' }],
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
});
