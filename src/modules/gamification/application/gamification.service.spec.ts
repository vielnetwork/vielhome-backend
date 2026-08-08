import { GamificationService } from './gamification.service';
import { GamificationPolicy } from '../domain/policies/gamification.policy';
import { DuplicateError, NotFoundAppError, UnexpectedAppError, ValidationError } from '../../../common/errors/app-error';
import { XP_CATALOG } from '../domain/xp-catalog';
import { DEFAULT_PAGE_LIMIT } from '../../../common/pagination/pagination.util';

/**
 * 21_ADRs > ADR-123 — Gamification Hardening Phase 1. `GamificationService`
 * had zero dedicated unit coverage before this pass (only e2e).
 * `GamificationRepository`/`AuditService`/`EventEmitter2` are fully mocked
 * (I/O isolation, same discipline `FinanceService.spec.ts` already
 * established) so these tests exercise the orchestration logic itself —
 * catalog lookup, event/audit emission, the new idempotency short-circuit,
 * and the new query validation — not Postgres (already covered by the real
 * e2e suite). `GamificationPolicy` is a real, un-mocked instance — it has
 * no dependencies and is already exhaustively covered by its own spec.
 */
describe('GamificationService', () => {
  let gamification: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let service: GamificationService;

  beforeEach(() => {
    gamification = {
      awardXp: jest.fn(),
      unlockAchievement: jest.fn(),
      revokeAchievement: jest.fn(),
      applyBuildingScoreDelta: jest.fn(),
      findXpTransactionByReference: jest.fn(),
      getPersonProgress: jest.fn(),
      listXpHistory: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getBuildingScore: jest.fn(),
      listLeaderboard: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getXpDistribution: jest.fn().mockResolvedValue([]),
      getLeagueDistribution: jest.fn().mockResolvedValue([]),
      countActiveParticipantsSince: jest.fn().mockResolvedValue(0),
      findMissingAchievementCodes: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };
    service = new GamificationService(
      gamification as never,
      new GamificationPolicy(),
      audit as never,
      events as never,
    );
  });

  describe('awardXp', () => {
    it('awards the exact XP_CATALOG amount for the reason and records/emits XpAwarded', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 10, isFirstOccurrence: false });

      await service.awardXp({ personId: 'p1', reason: 'PROFILE_CREATED' });

      expect(gamification.awardXp).toHaveBeenCalledWith(
        expect.objectContaining({ personId: 'p1', reason: 'PROFILE_CREATED', amount: XP_CATALOG.PROFILE_CREATED.amount }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'XpAwarded', metadata: expect.objectContaining({ amount: 10 }) }),
      );
      expect(events.emit).toHaveBeenCalledWith('XpAwarded', expect.anything());
    });

    it('unlocks the mapped achievement on first occurrence and emits AchievementUnlocked', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 85, isFirstOccurrence: true });
      gamification.unlockAchievement.mockResolvedValue({ title: 'یاور جامعه' });

      await service.awardXp({ personId: 'p1', buildingId: 'b1', reason: 'CASE_RESOLVED' });

      expect(gamification.unlockAchievement).toHaveBeenCalledWith('p1', 'COMMUNITY_HELPER', 'b1');
      expect(events.emit).toHaveBeenCalledWith('AchievementUnlocked', expect.anything());
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'AchievementUnlocked' }));
    });

    it('does NOT attempt to unlock an achievement when isFirstOccurrence is false (repeat award, permanent-achievement semantics)', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 45, isFirstOccurrence: false });

      await service.awardXp({ personId: 'p1', buildingId: 'b1', reason: 'CASE_RESOLVED' });

      expect(gamification.unlockAchievement).not.toHaveBeenCalled();
    });

    it('applies the reason’s Building Score delta only when a buildingId is present and the delta is non-zero', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 10, isFirstOccurrence: false });

      await service.awardXp({ personId: 'p1', reason: 'PROFILE_CREATED' }); // no buildingId, delta 0 anyway
      expect(gamification.applyBuildingScoreDelta).not.toHaveBeenCalled();

      gamification.applyBuildingScoreDelta.mockResolvedValue(null);
      await service.awardXp({ personId: 'p1', buildingId: 'b1', reason: 'CASE_RESOLVED' });
      expect(gamification.applyBuildingScoreDelta).toHaveBeenCalledWith('b1', XP_CATALOG.CASE_RESOLVED.buildingScoreDelta, 'CASE_RESOLVED', undefined);
    });

    it('emits LeagueTierChanged only when applyBuildingScoreDelta reports a real tier change (league promotion)', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 10, isFirstOccurrence: false });
      gamification.applyBuildingScoreDelta.mockResolvedValue({
        score: 100,
        previousTier: 'BRONZE',
        newTier: 'SILVER',
        tierChanged: true,
      });

      await service.awardXp({ personId: 'p1', buildingId: 'b1', reason: 'CASE_RESOLVED' });

      expect(events.emit).toHaveBeenCalledWith(
        'LeagueTierChanged',
        expect.objectContaining({ buildingId: 'b1', previousTier: 'BRONZE', newTier: 'SILVER', promoted: true }),
      );
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'LeagueTierChanged' }));
    });

    it('does not emit LeagueTierChanged when the tier did not change', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 10, isFirstOccurrence: false });
      gamification.applyBuildingScoreDelta.mockResolvedValue({
        score: 95,
        previousTier: 'BRONZE',
        newTier: 'BRONZE',
        tierChanged: false,
      });

      await service.awardXp({ personId: 'p1', buildingId: 'b1', reason: 'CASE_RESOLVED' });

      expect(events.emit).not.toHaveBeenCalledWith('LeagueTierChanged', expect.anything());
    });

    it('ADR-123: a duplicate/idempotent award ({ awarded: false } from the repository) is a clean no-op — no audit record, no XpAwarded/AchievementUnlocked/LeagueTierChanged event fires', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: false });

      await service.awardXp({
        personId: 'p1',
        buildingId: 'b1',
        reason: 'CASE_RESOLVED',
        referenceType: 'CASE',
        referenceId: 'case-1',
      });

      expect(audit.record).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(gamification.unlockAchievement).not.toHaveBeenCalled();
      expect(gamification.applyBuildingScoreDelta).not.toHaveBeenCalled();
    });
  });

  describe('clawbackChargePaidXp', () => {
    it('is a no-op when no original CHARGE_PAID award exists for the payment', async () => {
      gamification.findXpTransactionByReference.mockResolvedValue(null);

      await service.clawbackChargePaidXp({ paymentId: 'pay-1' });

      expect(gamification.awardXp).not.toHaveBeenCalled();
    });

    it('is a no-op (pre-check fast path) when a CHARGE_PAID_REVERSED row already exists for this payment', async () => {
      gamification.findXpTransactionByReference
        .mockResolvedValueOnce({ personId: 'p1', buildingId: 'b1' }) // CHARGE_PAID lookup
        .mockResolvedValueOnce({ id: 'already-clawed-back' }); // CHARGE_PAID_REVERSED lookup

      await service.clawbackChargePaidXp({ paymentId: 'pay-1' });

      expect(gamification.awardXp).not.toHaveBeenCalled();
    });

    it('awards the negative CHARGE_PAID_REVERSED amount/Building Score delta, referencing the same payment', async () => {
      gamification.findXpTransactionByReference
        .mockResolvedValueOnce({ personId: 'p1', buildingId: 'b1' })
        .mockResolvedValueOnce(null);
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 0, isFirstOccurrence: false });

      await service.clawbackChargePaidXp({ paymentId: 'pay-1', sourceEvent: 'PaymentReversed' });

      expect(gamification.awardXp).toHaveBeenCalledWith(
        expect.objectContaining({
          personId: 'p1',
          buildingId: 'b1',
          reason: 'CHARGE_PAID_REVERSED',
          amount: XP_CATALOG.CHARGE_PAID_REVERSED.amount,
          referenceType: 'PAYMENT',
          referenceId: 'pay-1',
        }),
      );
      expect(XP_CATALOG.CHARGE_PAID_REVERSED.amount).toBeLessThan(0);
      expect(XP_CATALOG.CHARGE_PAID_REVERSED.buildingScoreDelta).toBeLessThan(0);
    });

    it('ADR-123: even if a concurrent double-clawback attempt slips past the pre-check, the underlying awardXp call is the real, DB-backed idempotency guarantee (verified via GamificationRepository.spec.ts’s own P2002 coverage — this test only proves the service does not add its own extra guard on top that would mask a repository-level bug)', async () => {
      gamification.findXpTransactionByReference
        .mockResolvedValueOnce({ personId: 'p1', buildingId: 'b1' })
        .mockResolvedValueOnce(null);
      gamification.awardXp.mockResolvedValue({ awarded: false });

      await service.clawbackChargePaidXp({ paymentId: 'pay-1' });

      expect(audit.record).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('getLeaderboard', () => {
    const pagination = { page: 1, limit: DEFAULT_PAGE_LIMIT };

    it('passes a valid tier and translated skip/take straight through, returning items + pagination meta', async () => {
      gamification.listLeaderboard.mockResolvedValue({ items: [{ id: 'b1' }], total: 1 });
      const result = await service.getLeaderboard('GOLD', pagination);
      expect(gamification.listLeaderboard).toHaveBeenCalledWith('GOLD', { skip: 0, take: DEFAULT_PAGE_LIMIT });
      expect(result).toEqual({
        items: [{ id: 'b1' }],
        meta: expect.objectContaining({ page: 1, limit: DEFAULT_PAGE_LIMIT, total: 1 }),
      });
    });

    it('passes undefined straight through when no tier is given', async () => {
      gamification.listLeaderboard.mockResolvedValue({ items: [], total: 0 });
      await service.getLeaderboard(undefined, pagination);
      expect(gamification.listLeaderboard).toHaveBeenCalledWith(undefined, { skip: 0, take: DEFAULT_PAGE_LIMIT });
    });

    it('ADR-123: throws ValidationError for an invalid tier instead of silently querying (which would just return an empty 200)', () => {
      expect(() => service.getLeaderboard('NOT_A_REAL_TIER', pagination)).toThrow(ValidationError);
      expect(gamification.listLeaderboard).not.toHaveBeenCalled();
    });

    it('ADR-124: page 2 translates to the correct skip offset', async () => {
      gamification.listLeaderboard.mockResolvedValue({ items: [], total: 0 });
      await service.getLeaderboard(undefined, { page: 2, limit: 20 });
      expect(gamification.listLeaderboard).toHaveBeenCalledWith(undefined, { skip: 20, take: 20 });
    });
  });

  describe('getMyXpHistory', () => {
    const pagination = { page: 1, limit: DEFAULT_PAGE_LIMIT };

    it('paginates and returns items + pagination meta for the caller’s own personId only', async () => {
      gamification.listXpHistory.mockResolvedValue({ items: [{ id: 'tx-1' }], total: 1 });
      const result = await service.getMyXpHistory('p1', {}, pagination);
      expect(gamification.listXpHistory).toHaveBeenCalledWith('p1', {}, { skip: 0, take: DEFAULT_PAGE_LIMIT });
      expect(result).toEqual({
        items: [{ id: 'tx-1' }],
        meta: expect.objectContaining({ page: 1, total: 1 }),
      });
    });

    it('passes an optional reason filter through unchanged', async () => {
      gamification.listXpHistory.mockResolvedValue({ items: [], total: 0 });
      await service.getMyXpHistory('p1', { reason: 'ADMIN_CORRECTION' }, pagination);
      expect(gamification.listXpHistory).toHaveBeenCalledWith(
        'p1',
        { reason: 'ADMIN_CORRECTION' },
        { skip: 0, take: DEFAULT_PAGE_LIMIT },
      );
    });

    it('ADR-124: throws ValidationError for an Invalid Date fromDate', async () => {
      await expect(
        service.getMyXpHistory('p1', { fromDate: new Date('not-a-date') }, pagination),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(gamification.listXpHistory).not.toHaveBeenCalled();
    });

    it('ADR-124: throws ValidationError for an Invalid Date toDate', async () => {
      await expect(
        service.getMyXpHistory('p1', { toDate: new Date('not-a-date') }, pagination),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('ADR-124: throws ValidationError when fromDate is after toDate', async () => {
      const fromDate = new Date('2026-06-01');
      const toDate = new Date('2026-01-01');
      await expect(
        service.getMyXpHistory('p1', { fromDate, toDate }, pagination),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('adjustXp (Backoffice manual XP correction)', () => {
    it('awards ADMIN_CORRECTION with the staff-specified signed amount and records an audited XpAdjustedByAdmin entry, bypassing XP_CATALOG', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: true, newBalance: 120 });

      const result = await service.adjustXp({
        personId: 'p1',
        buildingId: 'b1',
        amount: -30,
        reason: 'Chargeback correction',
        actorPersonId: 'staff-1',
      });

      expect(gamification.awardXp).toHaveBeenCalledWith(
        expect.objectContaining({ personId: 'p1', buildingId: 'b1', reason: 'ADMIN_CORRECTION', amount: -30 }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'XpAdjustedByAdmin',
          actorId: 'staff-1',
          entityId: 'p1',
          reason: 'Chargeback correction',
          metadata: expect.objectContaining({ amount: -30, newBalance: 120 }),
        }),
      );
      expect(result).toEqual({ newBalance: 120 });
      // Deliberately no gameplay side effects for an admin correction.
      expect(events.emit).not.toHaveBeenCalled();
      expect(gamification.unlockAchievement).not.toHaveBeenCalled();
      expect(gamification.applyBuildingScoreDelta).not.toHaveBeenCalled();
    });

    it('throws UnexpectedAppError on the structurally-unreachable { awarded: false } path instead of silently returning a stale balance', async () => {
      gamification.awardXp.mockResolvedValue({ awarded: false });

      await expect(
        service.adjustXp({ personId: 'p1', amount: 10, reason: 'test', actorPersonId: 'staff-1' }),
      ).rejects.toBeInstanceOf(UnexpectedAppError);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('adjustBuildingScore (Backoffice manual Building Score correction)', () => {
    it('records the correction audit entry and reuses applyBuildingScoreDelta end-to-end (league recalculation + event emission)', async () => {
      gamification.applyBuildingScoreDelta.mockResolvedValue({
        score: 110,
        previousTier: 'BRONZE',
        newTier: 'SILVER',
        tierChanged: true,
      });

      await service.adjustBuildingScore({
        buildingId: 'b1',
        delta: 20,
        reason: 'Community event bonus',
        actorPersonId: 'staff-1',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BuildingScoreAdjustedByAdmin',
          actorId: 'staff-1',
          entityId: 'b1',
          reason: 'Community event bonus',
          metadata: { delta: 20 },
        }),
      );
      expect(gamification.applyBuildingScoreDelta).toHaveBeenCalledWith('b1', 20, 'ADMIN_CORRECTION', expect.any(String));
      // A genuine tier change from a correction gets the same event + audit as a gameplay-driven one.
      expect(events.emit).toHaveBeenCalledWith('BuildingScoreChanged', expect.anything());
      expect(events.emit).toHaveBeenCalledWith('LeagueTierChanged', expect.anything());
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'LeagueTierChanged' }));
    });
  });

  describe('grantAchievement (Backoffice manual achievement grant)', () => {
    it('unlocks the achievement and records an audited AchievementGrantedByAdmin entry', async () => {
      gamification.unlockAchievement.mockResolvedValue({ title: 'First Steps' });

      const result = await service.grantAchievement({
        personId: 'p1',
        code: 'FIRST_STEPS',
        reason: 'Manual correction for missed trigger',
        actorPersonId: 'staff-1',
      });

      expect(gamification.unlockAchievement).toHaveBeenCalledWith('p1', 'FIRST_STEPS', undefined);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AchievementGrantedByAdmin',
          actorId: 'staff-1',
          reason: 'Manual correction for missed trigger',
          metadata: { code: 'FIRST_STEPS' },
        }),
      );
      expect(result).toEqual({ title: 'First Steps' });
    });

    it('throws DuplicateError (409) when the person already actively holds this achievement, matching this codebase’s "already happened" convention', async () => {
      gamification.unlockAchievement.mockResolvedValue(null);

      await expect(
        service.grantAchievement({
          personId: 'p1',
          code: 'FIRST_STEPS',
          reason: 'test',
          actorPersonId: 'staff-1',
        }),
      ).rejects.toBeInstanceOf(DuplicateError);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('revokeAchievement (Backoffice manual achievement revoke)', () => {
    it('revokes the achievement and records an audited AchievementRevokedByAdmin entry', async () => {
      gamification.revokeAchievement.mockResolvedValue({ title: 'First Steps' });

      const result = await service.revokeAchievement({
        personId: 'p1',
        code: 'FIRST_STEPS',
        reason: 'Granted in error',
        actorPersonId: 'staff-1',
      });

      expect(gamification.revokeAchievement).toHaveBeenCalledWith('p1', 'FIRST_STEPS', 'staff-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AchievementRevokedByAdmin',
          actorId: 'staff-1',
          reason: 'Granted in error',
          metadata: { code: 'FIRST_STEPS' },
        }),
      );
      expect(result).toEqual({ title: 'First Steps' });
    });

    it('throws NotFoundAppError (404) when the person does not currently hold this achievement', async () => {
      gamification.revokeAchievement.mockResolvedValue(null);

      await expect(
        service.revokeAchievement({
          personId: 'p1',
          code: 'FIRST_STEPS',
          reason: 'test',
          actorPersonId: 'staff-1',
        }),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('getAnalytics', () => {
    it('resolves the three metrics for a valid (or absent) date range', async () => {
      const result = await service.getAnalytics();
      expect(result).toEqual(
        expect.objectContaining({ xpByReason: [], leagueDistribution: [], weeklyActiveParticipants: 0 }),
      );
    });

    it('ADR-123: throws ValidationError for an Invalid Date fromDate instead of letting it reach Prisma', async () => {
      await expect(service.getAnalytics(new Date('not-a-real-date'))).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(gamification.getXpDistribution).not.toHaveBeenCalled();
    });

    it('ADR-123: throws ValidationError for an Invalid Date toDate instead of letting it reach Prisma', async () => {
      await expect(
        service.getAnalytics(undefined, new Date('also-not-a-date')),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('ADR-123: throws ValidationError when fromDate is after toDate', async () => {
      const from = new Date('2026-06-01');
      const to = new Date('2026-01-01');
      await expect(service.getAnalytics(from, to)).rejects.toBeInstanceOf(ValidationError);
      expect(gamification.getXpDistribution).not.toHaveBeenCalled();
    });

    it('accepts a valid range where fromDate is before toDate', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-06-01');
      await expect(service.getAnalytics(from, to)).resolves.toBeDefined();
      expect(gamification.getXpDistribution).toHaveBeenCalledWith(from, to);
    });
  });

  describe('onModuleInit (achievement seed integrity)', () => {
    it('logs no error when every AchievementCode is seeded', async () => {
      gamification.findMissingAchievementCodes.mockResolvedValue([]);
      const errorSpy = jest.spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error');

      await service.onModuleInit();

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('ADR-123: logs a structured error naming every missing AchievementCode, without throwing (must not block boot)', async () => {
      gamification.findMissingAchievementCodes.mockResolvedValue(['COMMUNITY_HELPER']);
      const errorSpy = jest.spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error');

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('COMMUNITY_HELPER'));
    });
  });
});
