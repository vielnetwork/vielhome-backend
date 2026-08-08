import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { AdCampaignService } from '../application/ad-campaign.service';

/**
 * Monetization & Advertising — Phase 4 (Advertising Delivery API). Same
 * route shape as `BuildingGamificationController`: shares the `buildings`
 * base path, controller-level `JwtAuthGuard` (proves who), method-level
 * `MembershipGuard` (proves the caller belongs to `:id`). `MembershipGuard`
 * is wired in `AdvertisingModule` (imports `BuildingModule`, redeclares
 * `MembershipGuard` as a local provider) — see that module's own doc
 * comment for why.
 *
 * Read-only — no mutation/admin routes here (Phase 5). No impression/
 * click recording, no caching, no ranking beyond `priority` — those are
 * later phases too.
 */
@ApiTags('advertising')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class AdvertisingDeliveryController {
  constructor(private readonly campaigns: AdCampaignService) {}

  @Get(':id/advertising/placements/:placement')
  @UseGuards(MembershipGuard)
  getPlacementInventory(
    @Param('id') buildingId: string,
    @Param('placement') placement: string,
  ) {
    return this.campaigns.getPlacementInventory(buildingId, placement, new Date());
  }
}
