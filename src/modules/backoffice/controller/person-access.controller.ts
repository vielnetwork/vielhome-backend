import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PersonAccessService } from '../application/person-access.service';
import { SetBackofficeApprovalDto } from '../application/dto/set-backoffice-approval.dto';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Marketplace Access-Gate Implementation Phase. Platform-staff endpoint
 * for granting/revoking `Person.isBackofficeApproved` — the fact
 * `AccessGuard` checks for any route decorated `@RequiresAccess
 * ('BACKOFFICE_APPROVED')` (currently only `POST /marketplace/providers`
 * and Marketplace contact-detail visibility).
 *
 * Gated `@PlatformRoles('SENIOR_REVIEWER')` (satisfied by SENIOR_REVIEWER
 * or PLATFORM_ADMIN — `PlatformRolesGuard`'s rank hierarchy) per
 * requirement 3: this mirrors `fraud-case.controller.ts`'s own precedent
 * for consequential, account-affecting staff actions (`enforce`/`reopen`/
 * `decideAppeal` are all gated the same way). REVIEWER cannot reach this
 * route at all. No building role (`MembershipRole`) has any path here —
 * this controller is platform-staff-only end to end, never
 * `RolesGuard`/`@Roles`.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/persons/:personId/backoffice-approval', version: '1' })
export class PersonAccessController {
  constructor(
    private readonly service: PersonAccessService,
    private readonly backOffice: BackOfficeRepository,
  ) {}

  /**
   * Current approval fact for a given Person — staff-facing read, no
   * write. Also platform-staff-only (not exposed to the person themself
   * or to any building role).
   *
   * 21_ADRs > ADR-102 — `PermissionsGuard` added alongside the
   * pre-existing `PlatformRolesGuard`. Read maps to `PERSON_ACCESS_VIEW`,
   * the grant/revoke route to `PERSON_ACCESS_MANAGE`.
   */
  @Get()
  @PlatformRoles('REVIEWER')
  @RequiresPermission('PERSON_ACCESS_VIEW')
  async get(@Param('personId') personId: string) {
    const target = await this.backOffice.findPersonForBackofficeApproval(personId);
    return { personId, isBackofficeApproved: target?.isBackofficeApproved ?? null };
  }

  /**
   * Single grant/revoke endpoint (requirement 1) — `dto.approved` may be
   * `true` (grant) or `false` (revoke); both directions go through this
   * one route, never a separate always-additive "approve" action that
   * can't be undone.
   */
  @Post()
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('PERSON_ACCESS_MANAGE')
  set(
    @Param('personId') personId: string,
    @Body() dto: SetBackofficeApprovalDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.setBackofficeApproval(
      personId,
      dto.approved,
      user.sub,
      dto.reason,
      requestId,
    );
  }
}
