import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from '../application/marketplace.service';
import { DecideServiceProviderDto } from '../application/dto/decide-service-provider.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * "Marketplace Moderation" (07_BackOffice_v2.0's own Future Modules list)
 * — realized here on the `PlatformStaff`/`PlatformRolesGuard` foundation
 * ADR-029 built, rather than a second staff-authorization mechanism.
 */
@ApiTags('marketplace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/marketplace-providers', version: '1' })
export class MarketplaceModerationController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get()
  @PlatformRoles('REVIEWER')
  list(@Query('status') status?: string, @Query('category') category?: string) {
    return this.marketplace.listForReview({ status, category });
  }

  @Get(':id')
  @PlatformRoles('REVIEWER')
  getCase(@Param('id') id: string) {
    return this.marketplace.getCase(id);
  }

  @Post(':id/decide')
  @PlatformRoles('REVIEWER')
  decide(
    @Param('id') id: string,
    @Body() dto: DecideServiceProviderDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.marketplace.decide(id, dto.decision, user.sub, dto.reason, requestId);
  }

  @Post(':id/deactivate')
  @PlatformRoles('REVIEWER')
  deactivate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.marketplace.deactivate(id, user.sub, requestId);
  }
}
