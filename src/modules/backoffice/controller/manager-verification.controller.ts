import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ManagerVerificationService } from '../application/manager-verification.service';
import { DecideManagerVerificationDto } from '../application/dto/decide-manager-verification.dto';
import { RestoreManagerVerificationDto } from '../application/dto/restore-manager-verification.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** Manager Verification Queue (07.02) — Admin Review path, platform staff only. */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/manager-verifications', version: '1' })
export class ManagerVerificationController {
  constructor(private readonly service: ManagerVerificationService) {}

  @Get()
  @PlatformRoles('REVIEWER')
  list(@Query('status') status?: string, @Query('priority') priority?: string) {
    return this.service.listCases({ status, priority });
  }

  @Get(':caseId')
  @PlatformRoles('REVIEWER')
  getCase(@Param('caseId') caseId: string) {
    return this.service.getCase(caseId);
  }

  @Post(':caseId/decide')
  @PlatformRoles('SENIOR_REVIEWER')
  decide(
    @Param('caseId') caseId: string,
    @Body() dto: DecideManagerVerificationDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.decideCase(caseId, dto.decision, user.sub, dto.reason, requestId);
  }

  /** 21_ADRs > ADR-040 — "Restore" (07_BackOffice_v2.0's fourth named staff action, alongside Approve/Reject/Suspend). `:caseId` is the SUSPENDED case being restored, not the building — same shape as `decide`. */
  @Post(':caseId/restore')
  @PlatformRoles('SENIOR_REVIEWER')
  restore(
    @Param('caseId') caseId: string,
    @Body() dto: RestoreManagerVerificationDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.restoreManagement(caseId, user.sub, dto.reason, requestId);
  }
}
