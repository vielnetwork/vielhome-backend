import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from '../application/marketplace.service';
import { SubmitServiceProviderDto } from '../application/dto/submit-service-provider.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Public/own-scoped Marketplace routes (ADR-030) — platform-wide, not
 * building-scoped, so `JwtAuthGuard` alone (no `MembershipGuard`), same
 * authorization shape as `NotificationsController`/`GamificationController`.
 */
@ApiTags('marketplace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'marketplace/providers', version: '1' })
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Post()
  submit(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SubmitServiceProviderDto,
    @RequestId() requestId: string,
  ) {
    return this.marketplace.submit(user.sub, dto, requestId);
  }

  @Get()
  listApproved(@Query('category') category?: string, @Query('city') city?: string) {
    return this.marketplace.listApproved({ category: category as never, city });
  }

  // Must stay ABOVE `:id` below, same "literal segment before param" rule
  // BuildingController's `lookup` route already established.
  @Get('me')
  listMine(@CurrentUser() user: JwtPayload) {
    return this.marketplace.listMine(user.sub);
  }

  @Get(':id')
  getProvider(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.marketplace.getProvider(id, user.sub);
  }
}
