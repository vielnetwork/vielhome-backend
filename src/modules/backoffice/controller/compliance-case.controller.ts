import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ComplianceCaseService } from '../application/compliance-case.service';
import { OpenComplianceCaseDto } from '../application/dto/open-compliance-case.dto';
import { AssignComplianceCaseDto } from '../application/dto/assign-compliance-case.dto';
import { DecideComplianceCaseDto } from '../application/dto/decide-compliance-case.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Compliance Cases (07.06 Rules 011/012 — see 21_ADRs > ADR-034). Gated
 * at `SENIOR_REVIEWER`+ throughout — closer to 07.06's own "Compliance
 * Officer"/"Investigator" actors than `REVIEWER`, and one notch below the
 * `PLATFORM_ADMIN`-only raw `AuditLog` search this module already ships
 * (ADR-029) — see ADR-034 Decision for the full reasoning.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/compliance-cases', version: '1' })
export class ComplianceCaseController {
  constructor(private readonly service: ComplianceCaseService) {}

  @Post()
  @PlatformRoles('SENIOR_REVIEWER')
  open(
    @Body() dto: OpenComplianceCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.open(dto, user.sub, requestId);
  }

  @Get()
  @PlatformRoles('SENIOR_REVIEWER')
  list(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('priority') priority?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('subjectActorId') subjectActorId?: string,
  ) {
    return this.service.listCases({ status, category, priority, assignedToId, subjectActorId });
  }

  @Get(':caseId')
  @PlatformRoles('SENIOR_REVIEWER')
  getCase(@Param('caseId') caseId: string) {
    return this.service.getCase(caseId);
  }

  @Post(':caseId/assign')
  @PlatformRoles('SENIOR_REVIEWER')
  assign(
    @Param('caseId') caseId: string,
    @Body() dto: AssignComplianceCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.assign(caseId, dto.assignedToId, user.sub, requestId);
  }

  @Post(':caseId/decide')
  @PlatformRoles('SENIOR_REVIEWER')
  decide(
    @Param('caseId') caseId: string,
    @Body() dto: DecideComplianceCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.decide(caseId, dto.decision, user.sub, dto.reason, requestId);
  }

  /**
   * Runs `ComplianceCaseService.detectAnomalies` — the staff-triggered
   * stand-in for a not-yet-built scheduler (see the service's own header
   * comment). Returns the list of newly auto-opened cases.
   */
  @Post('detect')
  @PlatformRoles('SENIOR_REVIEWER')
  detect(@CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.service.detectAnomalies(user.sub, requestId);
  }
}
