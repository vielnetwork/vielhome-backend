import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserAdministrationService } from '../application/user-administration.service';
import { SuspendPersonDto } from '../application/dto/suspend-person.dto';
import { ReinstatePersonDto } from '../application/dto/reinstate-person.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-111 — User Administration (Stage 4). Reuses the
 * pre-existing, previously-unused `USER_VIEW`/`USER_EDIT` permission
 * keys (reserved since ADR-098, already granted to `Operations Admin`)
 * rather than introducing new ones — no schema/migration change in this
 * stage. Reads (list/detail) gated `REVIEWER`+ + `USER_VIEW`; both
 * mutations (`suspend`/`reinstate`) gated `SENIOR_REVIEWER`+ +
 * `USER_EDIT`, matching `PersonAccessController`'s own precedent for a
 * consequential, account-affecting staff action on the same `Person`
 * entity.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/users', version: '1' })
export class UserAdministrationController {
  constructor(private readonly service: UserAdministrationService) {}

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination), same convention as `SupportCaseController.list`. */
  @Get()
  @PlatformRoles('REVIEWER')
  @RequiresPermission('USER_VIEW')
  async list(
    @Query('search') search?: string,
    @Query('isSuspended') isSuspended?: string,
    @Query('isBackofficeApproved') isBackofficeApproved?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.list(
      {
        search,
        isSuspended: parseOptionalBoolean(isSuspended),
        isBackofficeApproved: parseOptionalBoolean(isBackofficeApproved),
      },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':personId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('USER_VIEW')
  getDetail(@Param('personId') personId: string) {
    return this.service.getDetail(personId);
  }

  @Post(':personId/suspend')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('USER_EDIT')
  suspend(
    @Param('personId') personId: string,
    @Body() dto: SuspendPersonDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.suspend(personId, user.sub, dto.reason, requestId);
  }

  @Post(':personId/reinstate')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('USER_EDIT')
  reinstate(
    @Param('personId') personId: string,
    @Body() dto: ReinstatePersonDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.reinstate(personId, user.sub, dto.reason, requestId);
  }
}

/** Tolerant boolean query-param parsing, same "never throw on an
 * optional filter" discipline `parsePagination` itself documents —
 * anything other than the literal strings `"true"`/`"false"` is treated
 * as "filter not applied" rather than a 400. */
function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}
