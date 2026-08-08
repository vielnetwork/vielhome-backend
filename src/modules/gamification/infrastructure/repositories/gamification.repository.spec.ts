import { Prisma } from '@prisma/client';
import { GamificationRepository } from './gamification.repository';
import { GamificationPolicy } from '../../domain/policies/gamification.policy';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * 21_ADRs > ADR-123 — Gamification Hardening Phase 1. `GamificationRepository`
 * had zero dedicated unit coverage before this pass (only e2e, plus
 * `GamificationPolicy`'s own pure-logic spec). `$transaction` is mocked to
 * synchronously invoke its callback with a fake `tx` object — the same
 * discipline `VotingRepository.spec.ts` already established for this exact
 * shape — exercising the repository's own orchestration/error-handling
 * logic directly, not Postgres itself (already covered by the real e2e
 * suite). `GamificationPolicy` is used as a real, un-mocked instance — it
 * has no dependencies and is already exhaustively covered by its own spec.
 */
describe('GamificationRepository', () => {
  const policy = new GamificationPolicy();

  function prismaKnownError(code: string) {
    const err = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
    err.code = code;
    return err;
  }

  describe('awardXp', () => {
    let tx: {
      xpTransaction: { count: jest.Mock; create: jest.Mock };
      person: { update: jest.Mock };
    };
    let transactionMock: jest.Mock;
    let repository: GamificationRepository;

    function setup() {
      tx = {
        xpTransaction: {
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue({}),
        },
        person: { update: jest.fn().mockResolvedValue({ xpBalance: 30 }) },
      };
      transactionMock = jest.fn((callback: (tx: unknown) => unknown) => callback(tx));
      repository = new GamificationRepository(
        { $transaction: transactionMock } as unknown as PrismaService,
        policy,
      );
    }

    it('creates the ledger row and increments Person.xpBalance atomically, reporting isFirstOccurrence: true on a person’s first award of this reason', async () => {
      setup();
      const result = await repository.awardXp({
        personId: 'p1',
        reason: 'PROFILE_CREATED',
        amount: 10,
      });

      expect(tx.xpTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ personId: 'p1', amount: 10, reason: 'PROFILE_CREATED' }),
        }),
      );
      expect(tx.person.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { xpBalance: { increment: 10 } },
      });
      expect(result).toEqual({ awarded: true, newBalance: 30, isFirstOccurrence: true });
    });

    it('reports isFirstOccurrence: false when a prior XpTransaction of this reason already exists for this person', async () => {
      setup();
      tx.xpTransaction.count.mockResolvedValue(1);
      const result = await repository.awardXp({ personId: 'p1', reason: 'CASE_RESOLVED', amount: 25 });
      expect(result).toEqual(expect.objectContaining({ isFirstOccurrence: false }));
    });

    it('passes referenceType/referenceId straight through to the ledger row when provided', async () => {
      setup();
      await repository.awardXp({
        personId: 'p1',
        reason: 'CASE_RESOLVED',
        amount: 25,
        referenceType: 'CASE',
        referenceId: 'case-1',
      });
      expect(tx.xpTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ referenceType: 'CASE', referenceId: 'case-1' }),
        }),
      );
    });

    it('ADR-123: converts a P2002 conflict on (referenceType, referenceId, reason) into a clean { awarded: false }, never a thrown error — the DB-level duplicate-award guard', async () => {
      setup();
      transactionMock.mockRejectedValue(prismaKnownError('P2002'));
      const result = await repository.awardXp({
        personId: 'p1',
        reason: 'CASE_RESOLVED',
        amount: 25,
        referenceType: 'CASE',
        referenceId: 'case-1',
      });
      expect(result).toEqual({ awarded: false });
    });

    it('re-throws a non-P2002 error unchanged (does not mistake an unrelated failure for a duplicate award)', async () => {
      setup();
      const other = new Error('connection reset');
      transactionMock.mockRejectedValue(other);
      await expect(
        repository.awardXp({ personId: 'p1', reason: 'CASE_RESOLVED', amount: 25 }),
      ).rejects.toBe(other);
    });
  });

  describe('unlockAchievement', () => {
    let tx: { personAchievement: { create: jest.Mock }; person: { update: jest.Mock } };
    let prisma: {
      achievementDefinition: { findUnique: jest.Mock };
      personAchievement: { findUnique: jest.Mock };
      $transaction: jest.Mock;
    };
    let repository: GamificationRepository;

    function setup() {
      tx = {
        personAchievement: { create: jest.fn().mockResolvedValue({}) },
        person: { update: jest.fn().mockResolvedValue({}) },
      };
      prisma = {
        achievementDefinition: { findUnique: jest.fn() },
        personAchievement: { findUnique: jest.fn() },
        $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(tx)),
      };
      repository = new GamificationRepository(prisma as unknown as PrismaService, policy);
    }

    it('returns null without throwing when no AchievementDefinition is seeded for the code (XP was already awarded separately, unaffected)', async () => {
      setup();
      prisma.achievementDefinition.findUnique.mockResolvedValue(null);
      const result = await repository.unlockAchievement('p1', 'FIRST_STEPS');
      expect(result).toBeNull();
      expect(tx.personAchievement.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns null without creating a second row when the person already holds this achievement (permanent, idempotent)', async () => {
      setup();
      prisma.achievementDefinition.findUnique.mockResolvedValue({
        id: 'def-1',
        title: 'X',
        xpBonus: 0,
      });
      prisma.personAchievement.findUnique.mockResolvedValue({ id: 'existing' });
      const result = await repository.unlockAchievement('p1', 'FIRST_STEPS');
      expect(result).toBeNull();
      expect(tx.personAchievement.create).not.toHaveBeenCalled();
    });

    it('creates the achievement row without touching Person.xpBalance when xpBonus is 0 (today’s only real seeded value)', async () => {
      setup();
      prisma.achievementDefinition.findUnique.mockResolvedValue({
        id: 'def-1',
        title: 'First Steps',
        xpBonus: 0,
      });
      prisma.personAchievement.findUnique.mockResolvedValue(null);

      const result = await repository.unlockAchievement('p1', 'FIRST_STEPS');

      expect(result).toEqual({ title: 'First Steps' });
      expect(tx.personAchievement.create).toHaveBeenCalledWith({
        data: { personId: 'p1', definitionId: 'def-1', buildingId: undefined },
      });
      expect(tx.person.update).not.toHaveBeenCalled();
    });

    it('ADR-123: a non-zero xpBonus increments Person.xpBalance in the SAME transaction as the achievement row — the dormant-but-now-verified bonus path', async () => {
      setup();
      prisma.achievementDefinition.findUnique.mockResolvedValue({
        id: 'def-2',
        title: 'Bonus Badge',
        xpBonus: 50,
      });
      prisma.personAchievement.findUnique.mockResolvedValue(null);

      const result = await repository.unlockAchievement('p1', 'FIRST_STEPS', 'b1');

      expect(result).toEqual({ title: 'Bonus Badge' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.personAchievement.create).toHaveBeenCalledWith({
        data: { personId: 'p1', definitionId: 'def-2', buildingId: 'b1' },
      });
      expect(tx.person.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { xpBalance: { increment: 50 } },
      });
    });
  });

  describe('findMissingAchievementCodes', () => {
    it('returns exactly the AchievementCode values with no matching seeded AchievementDefinition row', async () => {
      const prisma = {
        achievementDefinition: {
          findMany: jest.fn().mockResolvedValue([
            { code: 'FIRST_STEPS' },
            { code: 'BUILDING_FOUNDER' },
            { code: 'FIRST_PAYMENT' },
            { code: 'FIRST_VOTE' },
            // COMMUNITY_HELPER deliberately not seeded in this scenario
          ]),
        },
      };
      const repository = new GamificationRepository(prisma as unknown as PrismaService, policy);

      const missing = await repository.findMissingAchievementCodes();

      expect(missing).toEqual(['COMMUNITY_HELPER']);
    });

    it('returns an empty array when every AchievementCode is seeded', async () => {
      const prisma = {
        achievementDefinition: {
          findMany: jest.fn().mockResolvedValue([
            { code: 'FIRST_STEPS' },
            { code: 'BUILDING_FOUNDER' },
            { code: 'FIRST_PAYMENT' },
            { code: 'FIRST_VOTE' },
            { code: 'COMMUNITY_HELPER' },
          ]),
        },
      };
      const repository = new GamificationRepository(prisma as unknown as PrismaService, policy);

      expect(await repository.findMissingAchievementCodes()).toEqual([]);
    });
  });

  describe('applyBuildingScoreDelta', () => {
    let tx: {
      buildingScore: { upsert: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
      buildingScoreEvent: { create: jest.Mock };
    };
    let transactionMock: jest.Mock;
    let repository: GamificationRepository;

    function setup(before: { score: number; leagueTier: string }) {
      tx = {
        buildingScore: {
          upsert: jest.fn(),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'bs-1', ...before }),
          update: jest.fn(),
        },
        buildingScoreEvent: { create: jest.fn() },
      };
      transactionMock = jest.fn((callback: (tx: unknown) => unknown) => callback(tx));
      repository = new GamificationRepository(
        { $transaction: transactionMock } as unknown as PrismaService,
        policy,
      );
    }

    it('reports a real league promotion (BRONZE -> SILVER at the 100-point threshold) with tierChanged: true', async () => {
      setup({ score: 90, leagueTier: 'BRONZE' });
      const result = await repository.applyBuildingScoreDelta('b1', 10, 'CASE_RESOLVED');
      expect(result).toEqual(
        expect.objectContaining({
          score: 100,
          previousTier: 'BRONZE',
          newTier: 'SILVER',
          tierChanged: true,
        }),
      );
    });

    it('reports tierChanged: false when the delta does not cross a league threshold', async () => {
      setup({ score: 90, leagueTier: 'BRONZE' });
      const result = await repository.applyBuildingScoreDelta('b1', 5, 'VOTE_PARTICIPATED');
      expect(result).toEqual(expect.objectContaining({ score: 95, tierChanged: false }));
    });

    it('returns null (not a thrown error) when the BuildingScore row is concurrently deleted mid-transaction (P2025)', async () => {
      setup({ score: 0, leagueTier: 'BRONZE' });
      transactionMock.mockRejectedValue(prismaKnownError('P2025'));
      const result = await repository.applyBuildingScoreDelta('b1', 10, 'CASE_RESOLVED');
      expect(result).toBeNull();
    });

    it('re-throws a non-P2025 error unchanged', async () => {
      setup({ score: 0, leagueTier: 'BRONZE' });
      const other = new Error('boom');
      transactionMock.mockRejectedValue(other);
      await expect(repository.applyBuildingScoreDelta('b1', 10, 'CASE_RESOLVED')).rejects.toBe(
        other,
      );
    });
  });
});
