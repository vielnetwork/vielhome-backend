import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BuildingVerificationService } from '../application/building-verification.service';
import { DecideBuildingVerificationDto } from '../application/dto/decide-building-verification.dto';
import { AssignVerificationCaseDto } from '../application/dto/assign-verification-case.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** Building Verification Queue (07.01) — platform staff only. */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/building-verifications', version: '1' })
export class BuildingVerificationController {
  constructor(private readonly service: BuildingVerificationService) {}

  @Get()
  @PlatformRoles('REVIEWER')
  list(
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('assignedToId') assignedToId?: string,
  ) {
    return this.service.listCases({ status, priority, assignedToId });
  }

  @Get(':caseId')
  @PlatformRoles('REVIEWER')
  getCase(@Param('caseId') caseId: string) {
    return this.service.getCase(caseId);
  }

  @Post(':caseId/assign')
  @PlatformRoles('SENIOR_REVIEWER')
  assign(
    @Param('caseId') caseId: string,
    @Body() dto: AssignVerificationCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.assignCase(caseId, dto.assigneeId, user.sub, requestId);
  }

  @Post(':caseId/decide')
  @PlatformRoles('REVIEWER')
  decide(
    @Param('caseId') caseId: string,
    @Body() dto: DecideBuildingVerificationDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.decideCase(caseId, dto.decision, user.sub, dto.reason, requestId);
  }
}
