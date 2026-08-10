import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SubscriptionService } from '../application/subscription.service';
import { ChangeSubscriptionPlanDto } from '../application/dto/change-subscription-plan.dto';
import { ChangeSubscriptionStatusDto } from '../application/dto/change-subscription-status.dto';
import { CreateFeatureGrantDto } from '../application/dto/create-feature-grant.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import {
  EffectiveFeaturesEnvelopeDto,
  SubscriptionDetailEnvelopeDto,
  SubscriptionHistoryEnvelopeDto,
} from '../application/dto/subscription-read.dto';

/**
 * Subscription Management staff routes (07.04/04.04 — see 21_ADRs >
 * ADR-033). Platform staff only. Deliberately scoped to state management
 * (plan/status/grants/history/effective-features) — no billing, no
 * payment collection, no pricing enforcement this sprint.
 *
 * 21_ADRs > ADR-101 — first (and, per that ADR's scope redirect, only)
 * Bridge Migration pilot for this controller: `PermissionsGuard` is added
 * alongside the pre-existing `PlatformRolesGuard`, never replacing it
 * (both must pass). Reads map to `SUBSCRIPTION_VIEW`, state-changing
 * routes to `SUBSCRIPTION_MANAGE` — two permissions kept deliberately
 * separate from `FINANCE_VIEW`/`FINANCE_REFUND` (Subscription Management
 * is its own domain, not part of the Finance module, even though both
 * are billing-adjacent).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/buildings/:buildingId/subscription', version: '1' })
export class SubscriptionController {
  constructor(private readonly service: SubscriptionService) {}

  @Get()
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_VIEW')
  @ApiOkResponse({ type: SubscriptionDetailEnvelopeDto })
  get(@Param('buildingId') buildingId: string) {
    return this.service.getReadDetail(buildingId);
  }

  @Get('effective-features')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_VIEW')
  @ApiOkResponse({ type: EffectiveFeaturesEnvelopeDto })
  effectiveFeatures(@Param('buildingId') buildingId: string) {
    return this.service.resolveEffectiveFeatures(buildingId);
  }

  @Get('history')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_VIEW')
  @ApiOkResponse({ type: SubscriptionHistoryEnvelopeDto })
  history(@Param('buildingId') buildingId: string) {
    return this.service.getHistory(buildingId);
  }

  @Post('plan')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_MANAGE')
  changePlan(
    @Param('buildingId') buildingId: string,
    @Body() dto: ChangeSubscriptionPlanDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.changePlan(buildingId, dto.plan, user.sub, dto.reason, requestId);
  }

  @Post('status')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_MANAGE')
  changeStatus(
    @Param('buildingId') buildingId: string,
    @Body() dto: ChangeSubscriptionStatusDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.changeStatus(buildingId, dto.status, user.sub, dto.reason, requestId);
  }

  /** Manually applies the Trial/Grace-Period time-based transitions — standing in for the not-yet-built scheduler. See `SubscriptionService.evaluateExpiry`. */
  @Post('evaluate-expiry')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_MANAGE')
  evaluateExpiry(
    @Param('buildingId') buildingId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.evaluateExpiry(buildingId, user.sub, requestId);
  }

  @Post('grants')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_MANAGE')
  createGrant(
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateFeatureGrantDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.createGrant(
      buildingId,
      {
        featureKey: dto.featureKey,
        grantType: dto.grantType,
        reason: dto.reason,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
      user.sub,
      requestId,
    );
  }

  @Post('grants/:grantId/revoke')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('SUBSCRIPTION_MANAGE')
  revokeGrant(
    @Param('grantId') grantId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.revokeGrant(grantId, user.sub, requestId);
  }
}
