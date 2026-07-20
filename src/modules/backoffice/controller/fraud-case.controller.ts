import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FraudCaseService } from '../application/fraud-case.service';
import { OpenFraudCaseDto } from '../application/dto/open-fraud-case.dto';
import { AssignVerificationCaseDto } from '../application/dto/assign-verification-case.dto';
import { AddFraudEvidenceDto } from '../application/dto/add-fraud-evidence.dto';
import { DecideFraudCaseDto } from '../application/dto/decide-fraud-case.dto';
import { ReopenFraudCaseDto } from '../application/dto/reopen-fraud-case.dto';
import { EnforceFraudCaseDto } from '../application/dto/enforce-fraud-case.dto';
import { DecideEnforcementAppealDto } from '../application/dto/decide-enforcement-appeal.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** Fraud & Abuse Center staff queue (07.03) — platform staff only. */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard)
@Controller({ path: 'backoffice/fraud-cases', version: '1' })
export class FraudCaseController {
  constructor(private readonly service: FraudCaseService) {}

  @Post()
  @PlatformRoles('REVIEWER')
  open(
    @Body() dto: OpenFraudCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.openCase(dto, user.sub, requestId);
  }

  /** 21_ADRs > ADR-050 — 07.03 Rule 020's staff-facing fraud metrics. Read-only aggregate, gated at the same `SENIOR_REVIEWER`+ tier as Audit & Compliance's own `GET /backoffice/audit-logs/metrics` (ADR-034) and Support & Operations Center's own `GET .../support-cases/metrics` (ADR-048). Registered before `:caseId` so `/metrics` doesn't get swallowed by that param route. */
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
    @Query('assignedToId') assignedToId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.service.listCases(
      { status, priority, assignedToId },
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
    return this.service.assignCase(caseId, dto.assigneeId, user.sub, requestId);
  }

  @Post(':caseId/evidence')
  @PlatformRoles('REVIEWER')
  addEvidence(
    @Param('caseId') caseId: string,
    @Body() dto: AddFraudEvidenceDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.addEvidence(caseId, dto.evidenceNotes, user.sub, requestId);
  }

  @Post(':caseId/decide')
  @PlatformRoles('REVIEWER')
  decide(
    @Param('caseId') caseId: string,
    @Body() dto: DecideFraudCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.decideCase(caseId, dto.decision, user.sub, dto.reason, requestId);
  }

  @Post(':caseId/reopen')
  @PlatformRoles('SENIOR_REVIEWER')
  reopen(
    @Param('caseId') caseId: string,
    @Body() dto: ReopenFraudCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.reopenCase(caseId, dto.newEvidence, user.sub, requestId);
  }

  /**
   * 07.03 Rule 013/014 — issuing an enforcement action against a
   * CONFIRMED case. Route-level gate stays `SENIOR_REVIEWER`+ uniformly
   * (matching `assign`/`reopen`) — the finer per-severity check (21_ADRs
   * > ADR-044: `ACCOUNT_SUSPENSION` specifically requires `PLATFORM_ADMIN`)
   * lives in `FraudCaseService.enforce` itself, since a route-level
   * `@PlatformRoles(...)` decorator can't see the request body's `type`
   * field to branch on.
   */
  @Post(':caseId/enforce')
  @PlatformRoles('SENIOR_REVIEWER')
  enforce(
    @Param('caseId') caseId: string,
    @Body() dto: EnforceFraudCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.enforce(caseId, dto, user.sub, requestId);
  }

  @Post('enforcement-actions/:actionId/appeal-decision')
  @PlatformRoles('SENIOR_REVIEWER')
  decideAppeal(
    @Param('actionId') actionId: string,
    @Body() dto: DecideEnforcementAppealDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.decideEnforcementAppeal(
      actionId,
      dto.decision,
      user.sub,
      dto.reason,
      requestId,
    );
  }
}
