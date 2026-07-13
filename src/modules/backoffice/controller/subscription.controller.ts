import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SubscriptionService } from '../application/subscription.service';
import { ChangeSubscriptionPlanDto } from '../application/dto/change-subscription-plan.dto';
import { ChangeSubscriptionStatusDto } from '../application/dto/change-subscription-status.dto';
import { CreateFeatureGrantDto } from '../application/dto/create-feature-grant.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Subscription Management staff routes (07.04/04.04 — see 21_ADRs >
 * ADR-033). Platform staff only. Deliberately scoped to state management
 * (plan/status/grants/history/effective-features) — no billing, no
 * payment collection, no pricing enforcement this sprint.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/buildings/:buildingId/subscription', version: '1' })
export class SubscriptionController {
  constructor(private readonly service: SubscriptionService) {}

  @Get()
  @PlatformRoles('REVIEWER')
  get(@Param('buildingId') buildingId: string) {
    return this.service.getForBuilding(buildingId);
  }

  @Get('effective-features')
  @PlatformRoles('REVIEWER')
  effectiveFeatures(@Param('buildingId') buildingId: string) {
    return this.service.resolveEffectiveFeatures(buildingId);
  }

  @Get('history')
  @PlatformRoles('REVIEWER')
  history(@Param('buildingId') buildingId: string) {
    return this.service.getHistory(buildingId);
  }

  @Post('plan')
  @PlatformRoles('REVIEWER')
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
  evaluateExpiry(@Param('buildingId') buildingId: string, @CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.service.evaluateExpiry(buildingId, user.sub, requestId);
  }

  @Post('grants')
  @PlatformRoles('REVIEWER')
  createGrant(
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateFeatureGrantDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.createGrant(
      buildingId,
      { featureKey: dto.featureKey, grantType: dto.grantType, reason: dto.reason, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined },
      user.sub,
      requestId,
    );
  }

  @Post('grants/:grantId/revoke')
  @PlatformRoles('REVIEWER')
  revokeGrant(@Param('grantId') grantId: string, @CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.service.revokeGrant(grantId, user.sub, requestId);
  }
}
