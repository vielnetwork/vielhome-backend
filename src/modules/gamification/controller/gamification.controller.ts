import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { LeagueTier } from '@prisma/client';
import { GamificationService } from '../application/gamification.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Gamification MVP — personal progress + cross-building leaderboard
 * (15_Gamification_v2.0 — see 21_ADRs > ADR-028). Not nested under
 * `/buildings/:id/...` — same "own-scoped, no building :id param, JwtAuthGuard
 * alone is sufficient" shape as NotificationsController. The
 * building-scoped Building Score endpoint lives on `BuildingGamification
 * Controller` instead, since it needs `MembershipGuard`'s `:id` param.
 *
 * `GET /gamification/leaderboard` deliberately shows every building's
 * score/tier to any authenticated user, not just its own members — this
 * is the FIRST cross-building data this codebase exposes to end users
 * (every other domain has been strictly building-membership-scoped). It's
 * a deliberate choice matching 15_Gamification's own "Buildings compete
 * in leagues" framing (a league only means something if buildings can see
 * where they rank against others) — see ADR-028 Decision point 7 and
 * Future Review for the trade-off and how to restrict it later if needed.
 *
 * `GET /gamification/analytics` (ADR-047) is the one staff-only exception
 * on this controller — gated with an additional `PlatformRolesGuard` +
 * `@PlatformRoles('SENIOR_REVIEWER')` on top of the class-level
 * `JwtAuthGuard`, the same "class guard + extra route-level guard" shape
 * `CasesController` already uses for its own privileged-only routes.
 */
@ApiTags('gamification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'gamification', version: '1' })
export class GamificationController {
  constructor(private readonly gamification: GamificationService) {}

  @Get('me')
  getMyProgress(@CurrentUser() user: JwtPayload) {
    return this.gamification.getMyProgress(user.sub);
  }

  @Get('me/xp-history')
  getMyXpHistory(@CurrentUser() user: JwtPayload) {
    return this.gamification.getMyXpHistory(user.sub);
  }

  @Get('leaderboard')
  getLeaderboard(@Query('tier') tier?: LeagueTier) {
    return this.gamification.getLeaderboard(tier);
  }

  /** 21_ADRs > ADR-047 — a bounded slice of 15_Gamification's own Analytics section. Staff-only; see the class doc comment and `GamificationService.getAnalytics` for exactly what is/isn't computed and why. */
  @Get('analytics')
  @UseGuards(PlatformRolesGuard)
  @PlatformRoles('SENIOR_REVIEWER')
  getAnalytics(@Query('fromDate') fromDate?: string, @Query('toDate') toDate?: string) {
    return this.gamification.getAnalytics(fromDate ? new Date(fromDate) : undefined, toDate ? new Date(toDate) : undefined);
  }
}
