import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FraudCaseService } from '../application/fraud-case.service';
import { ReportFraudDto } from '../application/dto/report-fraud.dto';
import { AppealEnforcementDto } from '../application/dto/appeal-enforcement.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 07.03 Rule 002/019 — member-facing entry points: filing a fraud report,
 * and a sanctioned Person appealing an enforcement action issued against
 * them. Deliberately `JwtAuthGuard` only (no `RolesGuard`/`MembershipGuard`)
 * — same reasoning as `BuildingVerificationAppealController` (ADR-029): the
 * reporter/appellant may have no current, role-bearing Membership to check
 * against the target being reported.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'fraud-reports', version: '1' })
export class FraudReportController {
  constructor(private readonly service: FraudCaseService) {}

  @Post()
  report(
    @Body() dto: ReportFraudDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.report(dto, user.sub, requestId);
  }

  @Post('enforcement-actions/:actionId/appeal')
  appealEnforcement(
    @Param('actionId') actionId: string,
    @Body() dto: AppealEnforcementDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.appealEnforcement(actionId, user.sub, dto.reason, requestId);
  }
}
