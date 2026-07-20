import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SupportCaseService } from '../application/support-case.service';
import { OpenSupportCaseDto } from '../application/dto/open-support-case.dto';
import { AssignVerificationCaseDto } from '../application/dto/assign-verification-case.dto';
import { AddSupportCaseMessageDto } from '../application/dto/add-support-case-message.dto';
import { ResolveSupportCaseDto } from '../application/dto/resolve-support-case.dto';
import { MergeSupportCaseDto } from '../application/dto/merge-support-case.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** Support & Operations Center staff queue (07.05) — platform staff only. */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/support-cases', version: '1' })
export class SupportCaseController {
  constructor(private readonly service: SupportCaseService) {}

  /** Staff-opened ticket — for platform-internal operational issues with no member reporter. */
  @Post()
  @PlatformRoles('REVIEWER')
  open(
    @Body() dto: OpenSupportCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.open(dto, user.sub, requestId);
  }

  /** 21_ADRs > ADR-048 — 07.05 Rule 019/020's staff-facing metrics. Read-only aggregate, gated at the same `SENIOR_REVIEWER`+ tier as Audit & Compliance's own `GET /backoffice/audit-logs/metrics` (ADR-034). Registered before `:caseId` so `/metrics` doesn't get swallowed by that param route. */
  @Get('metrics')
  @PlatformRoles('SENIOR_REVIEWER')
  getMetrics(@Query('fromDate') fromDate?: string, @Query('toDate') toDate?: string) {
    return this.service.getMetrics(
      fromDate ? new Date(fromDate) : undefined,
      toDate ? new Date(toDate) : undefined,
    );
  }

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination). */
  @Get()
  @PlatformRoles('REVIEWER')
  async list(
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('category') category?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.listCases(
      { status, priority, category, assignedToId },
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
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
    return this.service.assign(caseId, dto.assigneeId, user.sub, requestId);
  }

  @Post(':caseId/messages')
  @PlatformRoles('REVIEWER')
  addMessage(
    @Param('caseId') caseId: string,
    @Body() dto: AddSupportCaseMessageDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.addStaffMessage(
      caseId,
      dto.body,
      dto.isInternal ?? false,
      user.sub,
      requestId,
    );
  }

  @Post(':caseId/resolve')
  @PlatformRoles('REVIEWER')
  resolve(
    @Param('caseId') caseId: string,
    @Body() dto: ResolveSupportCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.resolve(caseId, dto.resolutionCode, dto.resolution, user.sub, requestId);
  }

  @Post(':caseId/close')
  @PlatformRoles('REVIEWER')
  close(
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.close(caseId, user.sub, requestId);
  }

  @Post(':caseId/escalate')
  @PlatformRoles('SENIOR_REVIEWER')
  escalate(
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.escalate(caseId, user.sub, requestId);
  }

  @Post(':caseId/merge')
  @PlatformRoles('SENIOR_REVIEWER')
  merge(
    @Param('caseId') caseId: string,
    @Body() dto: MergeSupportCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.merge(caseId, dto.intoCaseId, user.sub, requestId);
  }
}
