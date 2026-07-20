import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from '../application/marketplace.service';
import { DecideServiceProviderDto } from '../application/dto/decide-service-provider.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
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

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination); structurally identical to the six BackOffice staff queues, added alongside them even though it wasn't one of `27_Performance_Review_v1.0`'s own named seven. */
  @Get()
  @PlatformRoles('REVIEWER')
  async list(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.marketplace.listForReview(
      { status, category },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
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
