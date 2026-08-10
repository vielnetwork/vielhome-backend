import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FinanceAdministrationService } from '../application/finance-administration.service';
import { AdminReversePaymentDto } from '../application/dto/admin-reverse-payment.dto';
import { RefundPaymentDto } from '../../finance/application/dto/refund-payment.dto';
import {
  AdminPaymentsFiltersDto,
  ListAdminPaymentsQueryDto,
} from '../application/dto/list-admin-payments-query.dto';
import {
  AdminPaymentDetailEnvelopeDto,
  AdminPaymentsListEnvelopeDto,
} from '../application/dto/admin-payment-read.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-113 — Financial Administration (Stage 6). Reuses the
 * pre-existing, previously-unused `FINANCE_VIEW`/`FINANCE_REFUND`
 * permission keys (reserved since ADR-098, already granted to Finance
 * Admin) rather than introducing new ones — no schema/migration change in
 * this stage. Reads (list/detail) gated `REVIEWER`+ + `FINANCE_VIEW`;
 * both mutations (`reverse`/`refund`) gated `SENIOR_REVIEWER`+ +
 * `FINANCE_REFUND`, matching `BuildingAdministrationController`'s own
 * precedent for a consequential, entity-affecting staff action distinct
 * from the target entity's own in-context workflow (here, the in-building
 * Finance module's own `FinanceController`, gated by building membership
 * role rather than platform-staff permission).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/payments', version: '1' })
export class FinanceAdministrationController {
  constructor(private readonly service: FinanceAdministrationService) {}

  /** 21_ADRs > ADR-072 — `page`/`limit` (08_API_Architecture > Pagination), same convention as `BuildingAdministrationController.list`. */
  @Get()
  @PlatformRoles('REVIEWER')
  @RequiresPermission('FINANCE_VIEW')
  @ApiOkResponse({ type: AdminPaymentsListEnvelopeDto })
  async list(@Query() query: ListAdminPaymentsQueryDto) {
    const { items, meta } = await this.service.list(
      { search: query.search, status: query.status, buildingId: query.buildingId },
      parsePagination(query.page, query.limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  /** 21_ADRs > ADR-115 — Reports & Export (Stage 8). CSV export of the
   * same filtered result set `list` already returns, reusing
   * `FINANCE_VIEW` rather than a separate export-specific permission —
   * the same precedent `AuditController.export` already established for
   * `AUDIT_VIEW` (ADR-034). Declared BEFORE `:paymentId` so `GET
   * .../export` is not swallowed by the id-param route. */
  @Get('export')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('FINANCE_VIEW')
  async exportCsv(
    @Query() query: AdminPaymentsFiltersDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.service.exportCsv(
      { search: query.search, status: query.status, buildingId: query.buildingId },
      user.sub,
      requestId,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payments-export.csv"');
    res.send(csv);
  }

  @Get(':paymentId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('FINANCE_VIEW')
  @ApiOkResponse({ type: AdminPaymentDetailEnvelopeDto })
  getDetail(@Param('paymentId') paymentId: string) {
    return this.service.getDetail(paymentId);
  }

  @Post(':paymentId/reverse')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('FINANCE_REFUND')
  reverse(
    @Param('paymentId') paymentId: string,
    @Body() dto: AdminReversePaymentDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.reverse(paymentId, user.sub, dto, requestId);
  }

  @Post(':paymentId/refund')
  @PlatformRoles('SENIOR_REVIEWER')
  @RequiresPermission('FINANCE_REFUND')
  refund(
    @Param('paymentId') paymentId: string,
    @Body() dto: RefundPaymentDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.refund(paymentId, user.sub, dto, requestId);
  }
}
