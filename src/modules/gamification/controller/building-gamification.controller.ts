import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GamificationService } from '../application/gamification.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';

/**
 * Building Score / League endpoint — shares the `buildings` base path
 * with the other domain controllers already on it (same "Nest resolves
 * by full path, no collision" precedent as FinanceController etc.).
 * `MembershipGuard` (any current member) — same rationale as read-only
 * building-scoped GETs elsewhere.
 */
@ApiTags('gamification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class BuildingGamificationController {
  constructor(private readonly gamification: GamificationService) {}

  @Get(':id/gamification/score')
  @UseGuards(MembershipGuard)
  getBuildingScore(@Param('id') buildingId: string) {
    return this.gamification.getBuildingScore(buildingId);
  }
}
