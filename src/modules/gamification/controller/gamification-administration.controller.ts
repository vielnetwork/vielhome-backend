import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GamificationAdministrationService } from '../application/gamification-administration.service';
import { AdjustXpDto } from '../application/dto/adjust-xp.dto';
import { AdjustBuildingScoreDto } from '../application/dto/adjust-building-score.dto';
import { GrantAchievementDto } from '../application/dto/grant-achievement.dto';
import { RevokeAchievementDto } from '../application/dto/revoke-achievement.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-124 — Backoffice Gamification correction tooling (item
 * 4A/4B/4C of Gamification Hardening Phase 2). Four staff-direct mutation
 * routes: manual XP correction, manual Building Score correction,
 * achievement grant, achievement revoke. Every route requires a mandatory
 * `reason` (see each DTO) and is fully audited (see `GamificationService`'s
 * own doc comments on each method).
 *
 * Gated `SENIOR_REVIEWER`+ + `GAMIFICATION_CORRECTION_MANAGE`, same
 * "consequential, entity-affecting staff action" bar
 * `FinanceAdministrationController.reverse`/`refund` already set (rather
 * than the lower `REVIEWER` bar `GamificationController.getAnalytics`
 * uses for a read-only view) — these routes directly mutate a person's XP
 * balance or a building's league standing, not just view it.
 *
 * Lives inside the `gamification` module's own file tree rather than
 * `backoffice/` — see `GamificationAdministrationService`'s own doc
 * comment for why (avoiding a circular module import). The `backoffice/
 * gamification` route prefix and `@ApiTags('backoffice')` are what
 * actually communicate this controller's administrative boundary to API
 * consumers, matching every other Backoffice controller's own path
 * convention (`backoffice/payments`, `backoffice/users`, ...).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/gamification', version: '1' })
export class GamificationAdministrationController {
  constructor(private readonly service: GamificationAdministrationService) {}

  @Post('persons/:personId/xp')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GAMIFICATION_CORRECTION_MANAGE')
  adjustXp(
    @Param('personId') personId: string,
    @Body() dto: AdjustXpDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.adjustXp(personId, dto, user.sub, requestId);
  }

  @Post('buildings/:buildingId/score')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GAMIFICATION_CORRECTION_MANAGE')
  adjustBuildingScore(
    @Param('buildingId') buildingId: string,
    @Body() dto: AdjustBuildingScoreDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.adjustBuildingScore(buildingId, dto, user.sub, requestId);
  }

  @Post('persons/:personId/achievements/grant')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GAMIFICATION_CORRECTION_MANAGE')
  grantAchievement(
    @Param('personId') personId: string,
    @Body() dto: GrantAchievementDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.grantAchievement(personId, dto, user.sub, requestId);
  }

  @Post('persons/:personId/achievements/revoke')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GAMIFICATION_CORRECTION_MANAGE')
  revokeAchievement(
    @Param('personId') personId: string,
    @Body() dto: RevokeAchievementDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.revokeAchievement(personId, dto, user.sub, requestId);
  }
}
