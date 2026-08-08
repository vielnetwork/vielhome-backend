import { Injectable } from '@nestjs/common';
import { GamificationService } from './gamification.service';
import { GamificationRepository } from '../infrastructure/repositories/gamification.repository';
import { AdjustXpDto } from './dto/adjust-xp.dto';
import { AdjustBuildingScoreDto } from './dto/adjust-building-score.dto';
import { GrantAchievementDto } from './dto/grant-achievement.dto';
import { RevokeAchievementDto } from './dto/revoke-achievement.dto';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * 21_ADRs > ADR-124 — Backoffice Gamification correction tooling (item
 * 4A/4B/4C). A thin wrapper around `GamificationService`'s four new
 * correction methods, adding one thing they don't do themselves: a clean
 * 404 (`NotFoundAppError`) for an unknown `personId`/`buildingId` path
 * param, checked before any transaction opens — matching
 * `FinanceAdministrationService`'s own "look the target up, 404 if
 * missing, delegate to the real service" shape (`reverse`/`refund`
 * against `FinanceRepository.findPaymentById`).
 *
 * Deliberately lives inside the `gamification` module's own file tree,
 * not `backoffice/`, even though every route on `GamificationAdministration
 * Controller` is Backoffice-only (route prefix `backoffice/gamification`,
 * `@ApiTags('backoffice')`) — `GamificationModule` already imports
 * `BackOfficeModule`/`BackofficeRbacModule` one-way (for `AuditService`/
 * RBAC guards), and `BackOfficeModule` does not import `GamificationModule`
 * back; placing this service/controller pair under `backoffice/` instead
 * would require exactly that reverse import, creating a circular module
 * dependency this codebase's existing module graph doesn't have anywhere
 * else. The route path and Swagger tag communicate the administrative
 * boundary to API consumers; the file location communicates it to the
 * module graph.
 */
@Injectable()
export class GamificationAdministrationService {
  constructor(
    private readonly gamification: GamificationService,
    private readonly repository: GamificationRepository,
  ) {}

  async adjustXp(personId: string, dto: AdjustXpDto, actorPersonId: string, requestId?: string) {
    await this.assertPersonExists(personId);
    if (dto.buildingId) {
      await this.assertBuildingExists(dto.buildingId);
    }
    return this.gamification.adjustXp({
      personId,
      buildingId: dto.buildingId,
      amount: dto.amount,
      reason: dto.reason,
      actorPersonId,
      requestId,
    });
  }

  async adjustBuildingScore(
    buildingId: string,
    dto: AdjustBuildingScoreDto,
    actorPersonId: string,
    requestId?: string,
  ) {
    await this.assertBuildingExists(buildingId);
    return this.gamification.adjustBuildingScore({
      buildingId,
      delta: dto.delta,
      reason: dto.reason,
      actorPersonId,
      requestId,
    });
  }

  async grantAchievement(
    personId: string,
    dto: GrantAchievementDto,
    actorPersonId: string,
    requestId?: string,
  ) {
    await this.assertPersonExists(personId);
    if (dto.buildingId) {
      await this.assertBuildingExists(dto.buildingId);
    }
    return this.gamification.grantAchievement({
      personId,
      code: dto.code,
      buildingId: dto.buildingId,
      reason: dto.reason,
      actorPersonId,
      requestId,
    });
  }

  async revokeAchievement(
    personId: string,
    dto: RevokeAchievementDto,
    actorPersonId: string,
    requestId?: string,
  ) {
    await this.assertPersonExists(personId);
    return this.gamification.revokeAchievement({
      personId,
      code: dto.code,
      reason: dto.reason,
      actorPersonId,
      requestId,
    });
  }

  private async assertPersonExists(personId: string): Promise<void> {
    if (!(await this.repository.personExists(personId))) {
      throw new NotFoundAppError('Person not found.');
    }
  }

  private async assertBuildingExists(buildingId: string): Promise<void> {
    if (!(await this.repository.buildingExists(buildingId))) {
      throw new NotFoundAppError('Building not found.');
    }
  }
}
