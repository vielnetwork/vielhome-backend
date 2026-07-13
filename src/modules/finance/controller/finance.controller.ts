import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FinanceService } from '../application/finance.service';
import { CreateFundDto } from '../application/dto/create-fund.dto';
import { CreateChargeBatchDto } from '../application/dto/create-charge-batch.dto';
import { CreatePaymentDto } from '../application/dto/create-payment.dto';
import { RejectPaymentDto } from '../application/dto/reject-payment.dto';
import { CreateAdjustmentDto } from '../application/dto/create-adjustment.dto';
import { ReversePaymentDto } from '../application/dto/reverse-payment.dto';
import { RefundPaymentDto } from '../application/dto/refund-payment.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Finance MVP (12_Finance_Architecture > ADR — Finance MVP; reconciled from
 * 10.08.01_Finance_Architecture, see 23_v1_Handoff_Package_Reconciliation
 * row 12). Shares the `buildings` base path with BuildingController — Nest
 * resolves routes across controllers by full path, so this is safe as long
 * as no method+path pair collides (see BuildingController's own routes:
 * none share a literal segment with `funds`, `charges`, `payments`,
 * `financial-summary` or `ledger`).
 *
 * Authorization mapping (10.08.01_Finance_Architecture > Authorization
 * Rules, applied via RolesGuard/MembershipGuard exactly like
 * BuildingController's Manager Assignment routes):
 *   - MANAGER creates Funds and Charge Batches, issues/cancels them.
 *   - ACCOUNTANT and MANAGER approve/reject Payments, create Adjustments,
 *     and reverse/refund Payments (08.05/08.06 — see 21_ADRs > ADR-037;
 *     same role pairing as payment approval, since both are financial
 *     corrections with the same real-money consequence).
 *   - Any current member may report a Payment and read Fund/Charge/Payment/
 *     Adjustment/Refund/Ledger data for their building — see
 *     FinanceService.createPayment's doc comment for why payment
 *     *reporting* isn't further role-gated.
 */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  // --- Funds -----------------------------------------------------------------

  @Post(':id/funds')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  createFund(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateFundDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.createFund(id, dto, user.sub, requestId);
  }

  @Get(':id/funds')
  @UseGuards(MembershipGuard)
  listFunds(@Param('id') id: string) {
    return this.finance.listFunds(id);
  }

  // --- Charge Batches ----------------------------------------------------------

  @Post(':id/charges')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  createChargeBatch(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateChargeBatchDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.createChargeBatch(id, dto, user.sub, requestId);
  }

  @Get(':id/charges')
  @UseGuards(MembershipGuard)
  listChargeBatches(@Param('id') id: string) {
    return this.finance.listChargeBatches(id);
  }

  @Get(':id/charges/:chargeBatchId')
  @UseGuards(MembershipGuard)
  getChargeBatch(@Param('id') id: string, @Param('chargeBatchId') chargeBatchId: string) {
    return this.finance.getChargeBatch(id, chargeBatchId);
  }

  @Patch(':id/charges/:chargeBatchId/issue')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  issueChargeBatch(
    @Param('id') id: string,
    @Param('chargeBatchId') chargeBatchId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.issueChargeBatch(id, chargeBatchId, user.sub, requestId);
  }

  @Patch(':id/charges/:chargeBatchId/cancel')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  cancelChargeBatch(
    @Param('id') id: string,
    @Param('chargeBatchId') chargeBatchId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.cancelChargeBatch(id, chargeBatchId, user.sub, requestId);
  }

  // --- Per-unit views ------------------------------------------------------------

  @Get(':id/units/:unitId/charge-items')
  @UseGuards(MembershipGuard)
  listUnitChargeItems(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.finance.listUnitChargeItems(id, unitId);
  }

  @Get(':id/units/:unitId/payments')
  @UseGuards(MembershipGuard)
  listUnitPayments(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.finance.listUnitPayments(id, unitId);
  }

  @Post(':id/units/:unitId/payments')
  @UseGuards(MembershipGuard)
  createPayment(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePaymentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.createPayment(id, unitId, dto, user.sub, requestId);
  }

  // --- Adjustments (08.05 Rule 014 — see 21_ADRs > ADR-037) --------------------

  @Get(':id/units/:unitId/debt')
  @UseGuards(MembershipGuard)
  getUnitDebt(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.finance.getUnitDebt(id, unitId);
  }

  @Get(':id/units/:unitId/adjustments')
  @UseGuards(MembershipGuard)
  listUnitAdjustments(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.finance.listUnitAdjustments(id, unitId);
  }

  @Post(':id/units/:unitId/adjustments')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  createAdjustment(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateAdjustmentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.createAdjustment(id, unitId, dto, user.sub, requestId);
  }

  // --- Payments --------------------------------------------------------------------

  @Get(':id/payments')
  @UseGuards(MembershipGuard)
  listPayments(@Param('id') id: string) {
    return this.finance.listPayments(id);
  }

  @Patch(':id/payments/:paymentId/approve')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  approvePayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.approvePayment(id, paymentId, user.sub, requestId);
  }

  @Patch(':id/payments/:paymentId/reject')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  rejectPayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RejectPaymentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.rejectPayment(id, paymentId, dto, user.sub, requestId);
  }

  // --- Payment Reversal & Refund (08.06 Rules 010/014/015 — ADR-037) -----------

  @Post(':id/payments/:paymentId/reverse')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  reversePayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReversePaymentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.reversePayment(id, paymentId, dto, user.sub, requestId);
  }

  @Post(':id/payments/:paymentId/refund')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  refundPayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RefundPaymentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.refundPayment(id, paymentId, dto, user.sub, requestId);
  }

  @Get(':id/payments/:paymentId/refunds')
  @UseGuards(MembershipGuard)
  listPaymentRefunds(@Param('id') id: string, @Param('paymentId') paymentId: string) {
    return this.finance.listPaymentRefunds(id, paymentId);
  }

  // --- Reporting -----------------------------------------------------------------

  @Get(':id/financial-summary')
  @UseGuards(MembershipGuard)
  getFinancialSummary(@Param('id') id: string) {
    return this.finance.getFinancialSummary(id);
  }

  @Get(':id/ledger')
  @UseGuards(MembershipGuard)
  listLedger(@Param('id') id: string, @Query('fundId') fundId?: string) {
    return this.finance.listLedger(id, fundId);
  }

  /** 21_ADRs > ADR-055 — Collection Rate, same `MembershipGuard` tier as `financial-summary`/`ledger` (any current member may read it). */
  @Get(':id/collection-rate')
  @UseGuards(MembershipGuard)
  getCollectionRate(
    @Param('id') id: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.getCollectionRate(
      id,
      fromDate ? new Date(fromDate) : undefined,
      toDate ? new Date(toDate) : undefined,
    );
  }

  /** 21_ADRs > ADR-057 — Payment Registration Rate, Collection Rate's sibling MVP metric, same `MembershipGuard` tier. */
  @Get(':id/payment-registration-rate')
  @UseGuards(MembershipGuard)
  getPaymentRegistrationRate(
    @Param('id') id: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.finance.getPaymentRegistrationRate(
      id,
      fromDate ? new Date(fromDate) : undefined,
      toDate ? new Date(toDate) : undefined,
    );
  }
}
