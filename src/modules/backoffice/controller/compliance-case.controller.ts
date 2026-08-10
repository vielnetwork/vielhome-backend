import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ComplianceCaseService } from '../application/compliance-case.service';
import { OpenComplianceCaseDto } from '../application/dto/open-compliance-case.dto';
import { AssignComplianceCaseDto } from '../application/dto/assign-compliance-case.dto';
import { DecideComplianceCaseDto } from '../application/dto/decide-compliance-case.dto';
import { ListComplianceCasesQueryDto } from '../application/dto/list-compliance-cases-query.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parseCasePagination } from '../application/case-query.util';
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
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/compliance-cases', version: '1' })
export class ComplianceCaseController {
  constructor(private readonly service: ComplianceCaseService) {}

  // 21_ADRs > ADR-102 — reads (list/get) map to COMPLIANCE_VIEW; every
  // mutation (open/assign/decide/detect) maps to COMPLIANCE_MANAGE. All
  // routes stay SENIOR_REVIEWER-tier at the legacy layer, unchanged.
  @Post()
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('COMPLIANCE_MANAGE')
  open(
    @Body() dto: OpenComplianceCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.open(dto, user.sub, requestId);
  }

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination). */
  @Get()
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('COMPLIANCE_VIEW')
  async list(@Query() query: ListComplianceCasesQueryDto) {
    const { items, meta } = await this.service.listCases(
      {
        status: query.status,
        category: query.category,
        priority: query.priority,
        assignedToId: query.assignedToId,
        subjectActorId: query.subjectActorId,
      },
      parseCasePagination(query.page, query.limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':caseId')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('COMPLIANCE_VIEW')
  getCase(@Param('caseId') caseId: string) {
    return this.service.getCase(caseId);
  }

  @Post(':caseId/assign')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('COMPLIANCE_MANAGE')
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
  @RequiresPermission('COMPLIANCE_MANAGE')
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
  @RequiresPermission('COMPLIANCE_MANAGE')
  detect(@CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.service.detectAnomalies(user.sub, requestId);
  }
}
