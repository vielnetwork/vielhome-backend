import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LegalHoldService } from '../application/legal-hold.service';
import { PlaceLegalHoldDto } from '../application/dto/place-legal-hold.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Legal Hold (07.06 Rule 015 — see 21_ADRs > ADR-034). Gated at
 * `PLATFORM_ADMIN` only, matching the existing raw `AuditLog` search
 * endpoint (ADR-029) — placing/releasing a hold on data tied to a legal
 * case is treated as at least as sensitive as reading the log itself.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/legal-holds', version: '1' })
export class LegalHoldController {
  constructor(private readonly service: LegalHoldService) {}

  @Post()
  @PlatformRoles('PLATFORM_ADMIN')
  place(
    @Body() dto: PlaceLegalHoldDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.place(dto, user.sub, requestId);
  }

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination). */
  @Get()
  @PlatformRoles('PLATFORM_ADMIN')
  async list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.list(
      {
        entityType,
        entityId,
        isActive: isActive === undefined ? undefined : isActive === 'true',
      },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Post(':holdId/release')
  @PlatformRoles('PLATFORM_ADMIN')
  release(
    @Param('holdId') holdId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.release(holdId, user.sub, requestId);
  }
}
