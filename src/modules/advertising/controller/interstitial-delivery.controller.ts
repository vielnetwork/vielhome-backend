import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { AdCampaignService } from '../application/ad-campaign.service';
import { InterstitialDeliveryQueryDto } from '../application/dto/interstitial-delivery.dto';

@ApiTags('advertising')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'advertising', version: '1' })
export class InterstitialDeliveryController {
  constructor(private readonly campaigns: AdCampaignService) {}

  @Get('placements/:placement')
  getInterstitial(
    @CurrentUser() user: JwtPayload,
    @Param('placement') placement: string,
    @Query() query: InterstitialDeliveryQueryDto,
  ) {
    return this.campaigns.getInterstitialInventory(
      user.sub,
      placement,
      query.buildingId,
      new Date(),
    );
  }
}
