import { Controller, Get, ParseEnumPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { XpReason } from '@prisma/client';
import { GamificationService } from '../application/gamification.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { parsePagination } from '../../../common/pagination/pagination.util';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';

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

  /**
   * 21_ADRs > ADR-124 — paginated, with optional `reason`/`fromDate`/
   * `toDate` filters. `reason` is validated here via
   * `ParseEnumPipe(XpReason, { optional: true })` — the same per-param
   * enum-pipe convention `CasesController.listCases` already uses for
   * `type`/`status`/`priority` — so it always reaches the service as
   * either `undefined` or a real `XpReason`, a clean 400 otherwise.
   * `fromDate`/`toDate` are passed through as raw strings and validated
   * in the service (mirroring `getAnalytics` below). `page`/`limit` use
   * the same tolerant `parsePagination` every other paginated list
   * endpoint in this codebase uses. Strictly own-scoped — `personId`
   * always comes from the caller's own JWT, never a query/path param.
   */
  @Get('me/xp-history')
  async getMyXpHistory(
    @CurrentUser() user: JwtPayload,
    @Query('reason', new ParseEnumPipe(XpReason, { optional: true })) reason?: XpReason,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.gamification.getMyXpHistory(
      user.sub,
      {
        reason,
        fromDate: fromDate ? new Date(fromDate) : undefined,
        toDate: toDate ? new Date(toDate) : undefined,
      },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  /**
   * 21_ADRs > ADR-123 — `tier` is read as a plain optional string (a
   * query param is always a string on the wire regardless of what a type
   * annotation here claimed) and validated by `GamificationService.
   * getLeaderboard` itself, which throws a clean `ValidationError` (400)
   * for anything that isn't a real `LeagueTier` value — see that method's
   * own doc comment for why validation lives there rather than in a bound
   * `@Query()` DTO (matching `AnalyticsService.resolveRange`'s existing
   * precedent for this same kind of check, not a new pattern).
   *
   * 21_ADRs > ADR-124 — now also paginated via the same `page`/`limit`
   * convention as `me/xp-history` above.
   */
  @Get('leaderboard')
  async getLeaderboard(
    @Query('tier') tier?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.gamification.getLeaderboard(
      tier,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  /**
   * 21_ADRs > ADR-047 — a bounded slice of 15_Gamification's own Analytics
   * section. Staff-only; see the class doc comment and
   * `GamificationService.getAnalytics` for exactly what is/isn't computed
   * and why.
   *
   * 21_ADRs > ADR-102 — `PermissionsGuard` added at the method level,
   * alongside the pre-existing method-level `PlatformRolesGuard` (this is
   * the only route on this controller that's platform-staff-gated at
   * all, so the class-level guard chain is deliberately left as plain
   * `JwtAuthGuard` — adding `PermissionsGuard` there would wrongly gate
   * every customer-facing route on this controller too).
   */
  @Get('analytics')
  @UseGuards(PlatformRolesGuard, PermissionsGuard)
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('GAMIFICATION_ANALYTICS_VIEW')
  getAnalytics(@Query('fromDate') fromDate?: string, @Query('toDate') toDate?: string) {
    return this.gamification.getAnalytics(
      fromDate ? new Date(fromDate) : undefined,
      toDate ? new Date(toDate) : undefined,
    );
  }
}
