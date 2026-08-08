import { GamificationAdministrationService } from './gamification-administration.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * 21_ADRs > ADR-124 — `GamificationAdministrationService` unit coverage.
 * `GamificationService`/`GamificationRepository` are fully mocked — these
 * tests only verify the one thing this thin wrapper adds on top of
 * `GamificationService`'s own methods (already covered by
 * `gamification.service.spec.ts`): a clean 404 for an unknown
 * `personId`/`buildingId`, checked before delegating.
 */
describe('GamificationAdministrationService', () => {
  let gamificationService: Record<string, jest.Mock>;
  let repository: { personExists: jest.Mock; buildingExists: jest.Mock };
  let service: GamificationAdministrationService;

  beforeEach(() => {
    gamificationService = {
      adjustXp: jest.fn().mockResolvedValue({ newBalance: 100 }),
      adjustBuildingScore: jest.fn().mockResolvedValue(undefined),
      grantAchievement: jest.fn().mockResolvedValue({ title: 'First Steps' }),
      revokeAchievement: jest.fn().mockResolvedValue({ title: 'First Steps' }),
    };
    repository = {
      personExists: jest.fn().mockResolvedValue(true),
      buildingExists: jest.fn().mockResolvedValue(true),
    };
    service = new GamificationAdministrationService(gamificationService as never, repository as never);
  });

  describe('adjustXp', () => {
    it('delegates to GamificationService.adjustXp when the person (and optional building) exist', async () => {
      const dto = { amount: 10, reason: 'test', buildingId: 'b1' };
      const result = await service.adjustXp('p1', dto as never, 'staff-1', 'req-1');

      expect(repository.personExists).toHaveBeenCalledWith('p1');
      expect(repository.buildingExists).toHaveBeenCalledWith('b1');
      expect(gamificationService.adjustXp).toHaveBeenCalledWith({
        personId: 'p1',
        buildingId: 'b1',
        amount: 10,
        reason: 'test',
        actorPersonId: 'staff-1',
        requestId: 'req-1',
      });
      expect(result).toEqual({ newBalance: 100 });
    });

    it('throws NotFoundAppError for an unknown personId without calling GamificationService', async () => {
      repository.personExists.mockResolvedValue(false);
      await expect(
        service.adjustXp('missing', { amount: 10, reason: 'test' } as never, 'staff-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(gamificationService.adjustXp).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppError for an unknown buildingId without calling GamificationService', async () => {
      repository.buildingExists.mockResolvedValue(false);
      await expect(
        service.adjustXp('p1', { amount: 10, reason: 'test', buildingId: 'missing' } as never, 'staff-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(gamificationService.adjustXp).not.toHaveBeenCalled();
    });
  });

  describe('adjustBuildingScore', () => {
    it('delegates to GamificationService.adjustBuildingScore when the building exists', async () => {
      const dto = { delta: 5, reason: 'test' };
      await service.adjustBuildingScore('b1', dto as never, 'staff-1', 'req-1');

      expect(repository.buildingExists).toHaveBeenCalledWith('b1');
      expect(gamificationService.adjustBuildingScore).toHaveBeenCalledWith({
        buildingId: 'b1',
        delta: 5,
        reason: 'test',
        actorPersonId: 'staff-1',
        requestId: 'req-1',
      });
    });

    it('throws NotFoundAppError for an unknown buildingId', async () => {
      repository.buildingExists.mockResolvedValue(false);
      await expect(
        service.adjustBuildingScore('missing', { delta: 5, reason: 'test' } as never, 'staff-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(gamificationService.adjustBuildingScore).not.toHaveBeenCalled();
    });
  });

  describe('grantAchievement', () => {
    it('delegates to GamificationService.grantAchievement when the person exists', async () => {
      const dto = { code: 'FIRST_STEPS', reason: 'test' };
      const result = await service.grantAchievement('p1', dto as never, 'staff-1', 'req-1');

      expect(gamificationService.grantAchievement).toHaveBeenCalledWith({
        personId: 'p1',
        code: 'FIRST_STEPS',
        buildingId: undefined,
        reason: 'test',
        actorPersonId: 'staff-1',
        requestId: 'req-1',
      });
      expect(result).toEqual({ title: 'First Steps' });
    });

    it('throws NotFoundAppError for an unknown personId', async () => {
      repository.personExists.mockResolvedValue(false);
      await expect(
        service.grantAchievement('missing', { code: 'FIRST_STEPS', reason: 'test' } as never, 'staff-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(gamificationService.grantAchievement).not.toHaveBeenCalled();
    });
  });

  describe('revokeAchievement', () => {
    it('delegates to GamificationService.revokeAchievement when the person exists', async () => {
      const dto = { code: 'FIRST_STEPS', reason: 'test' };
      const result = await service.revokeAchievement('p1', dto as never, 'staff-1', 'req-1');

      expect(gamificationService.revokeAchievement).toHaveBeenCalledWith({
        personId: 'p1',
        code: 'FIRST_STEPS',
        reason: 'test',
        actorPersonId: 'staff-1',
        requestId: 'req-1',
      });
      expect(result).toEqual({ title: 'First Steps' });
    });

    it('throws NotFoundAppError for an unknown personId', async () => {
      repository.personExists.mockResolvedValue(false);
      await expect(
        service.revokeAchievement('missing', { code: 'FIRST_STEPS', reason: 'test' } as never, 'staff-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(gamificationService.revokeAchievement).not.toHaveBeenCalled();
    });
  });
});
