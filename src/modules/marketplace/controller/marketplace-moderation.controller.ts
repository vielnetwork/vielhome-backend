import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from '../application/marketplace.service';
import { DecideServiceProviderDto } from '../application/dto/decide-service-provider.dto';
import { RejectServiceProviderDto } from '../application/dto/reject-service-provider.dto';
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
 *
 * ADR-097 — Marketplace Review Workflow (Phase 2) adds `pending`/
 * `approve`/`reject`/`archive`, additive named wrappers around the
 * pre-existing `list`/`decide` (both unchanged) — see each method's own
 * doc comment.
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

  // Must stay ABOVE `:id` below, same "literal segment before param" rule
  // `MarketplaceController.listMine`'s own `me` route already established.
  /** ADR-097 requirement 4. Thin, named wrapper around `list`/
   * `listForReview` filtered to PENDING — the generic `?status=PENDING`
   * query on `list` above still works exactly as before; this is purely
   * an additive convenience matching the ADR's explicit endpoint list. */
  @Get('pending')
  @PlatformRoles('REVIEWER')
  async pending(@Query('page') page?: string, @Query('limit') limit?: string) {
    const { items, meta } = await this.marketplace.listPending(parsePagination(page, limit));
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

  /** ADR-097 requirement 4. Thin wrapper around `decide('APPROVE', ...)`. */
  @Post(':id/approve')
  @PlatformRoles('REVIEWER')
  approve(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.marketplace.approve(id, user.sub, requestId);
  }

  /** ADR-097 requirement 4. Thin wrapper around `decide('REJECT', ...)`;
   * `reason` is required (`RejectServiceProviderDto`), unlike the
   * pre-existing `/decide` route. */
  @Post(':id/reject')
  @PlatformRoles('REVIEWER')
  reject(
    @Param('id') id: string,
    @Body() dto: RejectServiceProviderDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.marketplace.reject(id, user.sub, dto.reason, requestId);
  }

  /** ADR-097 requirement 4. APPROVED -> ARCHIVED. */
  @Post(':id/archive')
  @PlatformRoles('REVIEWER')
  archive(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.marketplace.archive(id, user.sub, requestId);
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
