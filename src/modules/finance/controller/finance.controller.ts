import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FinanceService } from '../application/finance.service';
import { CreateFundDto } from '../application/dto/create-fund.dto';
import { UpdateFundDto } from '../application/dto/update-fund.dto';
import { CreateChargeBatchDto } from '../application/dto/create-charge-batch.dto';
import { CreateChargeSeriesDto } from '../application/dto/create-charge-series.dto';
import { CreatePaymentDto } from '../application/dto/create-payment.dto';
import { CreateExplicitPaymentDto } from '../application/dto/create-explicit-payment.dto';
import { RejectPaymentDto } from '../application/dto/reject-payment.dto';
import { CreateAdjustmentDto } from '../application/dto/create-adjustment.dto';
import { CorrectOpeningBalanceDto } from '../application/dto/correct-opening-balance.dto';
import { ReversePaymentDto } from '../application/dto/reverse-payment.dto';
import { RefundPaymentDto } from '../application/dto/refund-payment.dto';
import { CreateExpenseDto } from '../application/dto/create-expense.dto';
import { VoidExpenseDto } from '../application/dto/void-expense.dto';
import { ChargeOptionsDto } from '../application/dto/charge-options.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { parsePagination } from '../../../common/pagination/pagination.util';
import { ValidationError } from '../../../common/errors/app-error';
import { PaymentStatus, ExpenseCategory, ExpenseStatus } from '@prisma/client';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** Backend ↔ Mobile Contract Alignment — every legal `Payment.status` value, for validating the optional `?status=` filter on `GET :id/payments` below. */
const VALID_PAYMENT_STATUSES: string[] = Object.values(PaymentStatus);

/** FIN-EXP-02 — every legal `Expense.category`/`.status` value, for validating the optional `?category=`/`?status=` filters on `GET :id/expenses` below (same defensive pattern as `VALID_PAYMENT_STATUSES` above). */
const VALID_EXPENSE_CATEGORIES: string[] = Object.values(ExpenseCategory);
const VALID_EXPENSE_STATUSES: string[] = Object.values(ExpenseStatus);

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

  @Get(':id/finance/unit-debts')
  @UseGuards(MembershipGuard)
  async listUnitDebtSummaries(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listUnitDebtSummaries(
      id,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

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

  /** Finance Hardening Pass (post-audit) — `page`/`limit` (ADR-072 convention), same pattern `FinanceAdministrationController.list`/`MarketplaceController.listApproved` already established. */
  @Get(':id/funds')
  @UseGuards(MembershipGuard)
  async listFunds(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listFunds(id, parsePagination(page, limit));
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':id/funds/:fundId')
  @UseGuards(MembershipGuard)
  getFund(@Param('id') id: string, @Param('fundId') fundId: string) {
    return this.finance.getFund(id, fundId);
  }

  @Patch(':id/funds/:fundId')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  updateFund(
    @Param('id') id: string,
    @Param('fundId') fundId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateFundDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.updateFund(id, fundId, dto, user.sub, requestId);
  }

  /** ADR-094 (Sprint 29) — deactivation, not deletion; see Fund model's own schema comment for why a Fund is never hard-deleted. */
  @Patch(':id/funds/:fundId/deactivate')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  deactivateFund(
    @Param('id') id: string,
    @Param('fundId') fundId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.deactivateFund(id, fundId, user.sub, requestId);
  }

  @Patch(':id/funds/:fundId/reactivate')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  reactivateFund(
    @Param('id') id: string,
    @Param('fundId') fundId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.reactivateFund(id, fundId, user.sub, requestId);
  }

  // --- Charge Batches ----------------------------------------------------------

  @Get(':id/charge-options')
  @UseGuards(MembershipGuard)
  @ApiOkResponse({ type: ChargeOptionsDto })
  getChargeOptions(@Param('id') id: string) {
    return this.finance.getChargeOptions(id);
  }

  @Get(':id/charge-series')
  @UseGuards(MembershipGuard)
  listChargeSeries(@Param('id') id: string) {
    return this.finance.listChargeSeries(id);
  }

  @Post(':id/charge-series')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  createChargeSeries(@Param('id') id: string, @Body() dto: CreateChargeSeriesDto) {
    return this.finance.createChargeSeries(id, dto);
  }

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

  /**
   * ADR-095 (Sprint 29, Charge Generation Phase 2) — zero-write preview,
   * same DTO as `POST :id/charges` and the exact same calculation/payer-
   * resolution functions, so the two can never structurally drift. Same
   * MANAGER gate as the real create — a preview reveals resolved payer
   * identities (Person ids), which is financial/PII-adjacent data, not a
   * read any building member should get by default.
   */
  @Post(':id/charges/preview')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  previewChargeBatch(@Param('id') id: string, @Body() dto: CreateChargeBatchDto) {
    return this.finance.previewChargeBatch(id, dto);
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  @Get(':id/charges')
  @UseGuards(MembershipGuard)
  async listChargeBatches(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listChargeBatches(id, parsePagination(page, limit));
    return withEnvelope(items, { metadata: { pagination: meta } });
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

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  @Get(':id/units/:unitId/charge-items')
  @UseGuards(MembershipGuard)
  async listUnitChargeItems(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listUnitChargeItems(
      id,
      unitId,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  @Get(':id/units/:unitId/payments')
  @UseGuards(MembershipGuard)
  async listUnitPayments(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listUnitPayments(
      id,
      unitId,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  /**
   * FIN-MVP-GAP-04C — the controlled Manual / On-Behalf Payment contract.
   * Restricted to MANAGER/ACCOUNTANT of the building (`RolesGuard`, same
   * pattern as `correctOpeningBalance`/`createAdjustment` below) — an
   * ordinary Owner/Tenant/member can no longer call this route merely by
   * being a building member. Resident self-service stays on
   * `createExplicitPayment` below, unchanged. See `CreatePaymentDto`'s own
   * doc comment for the `payerPersonId`/`idempotencyKey` contract.
   */
  @Post(':id/units/:unitId/payments')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  createPayment(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePaymentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.createPayment(id, unitId, dto, user.sub, requestId);
  }

  @Get(':id/units/:unitId/obligations')
  @UseGuards(MembershipGuard)
  getSelectableObligations(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.finance.getSelectableObligations(id, unitId, user.sub);
  }

  @Post(':id/units/:unitId/payments/explicit')
  @UseGuards(MembershipGuard)
  createExplicitPayment(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateExplicitPaymentDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.createExplicitPayment(id, unitId, dto, user.sub, requestId);
  }

  // --- Adjustments (08.05 Rule 014 — see 21_ADRs > ADR-037) --------------------

  @Get(':id/units/:unitId/debt')
  @UseGuards(MembershipGuard)
  getUnitDebt(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.finance.getUnitDebt(id, unitId);
  }

  /** Finance Correction Pass — read-side companion to `correctOpeningBalance` below; see `FinanceService.getUnitOpeningBalance`'s own doc comment. */
  @Get(':id/units/:unitId/opening-balance')
  @UseGuards(MembershipGuard)
  getUnitOpeningBalance(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.finance.getUnitOpeningBalance(id, unitId);
  }

  /**
   * Finance Correction Pass — corrects a unit's effective opening balance.
   * Same role gate and same underlying Adjustment/Ledger mechanism as
   * manual Adjustment creation — see `FinanceService.correctOpeningBalance`'s
   * own doc comment for the full design and for why an Accountant existing
   * on the building never revokes the Manager's own authority.
   */
  @Post(':id/units/:unitId/opening-balance-correction')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  correctOpeningBalance(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CorrectOpeningBalanceDto,
    @RequestId() requestId: string,
  ) {
    return this.finance.correctOpeningBalance(id, unitId, dto, user.sub, requestId);
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  @Get(':id/units/:unitId/adjustments')
  @UseGuards(MembershipGuard)
  async listUnitAdjustments(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listUnitAdjustments(
      id,
      unitId,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
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

  /**
   * ADR-095 — applies an eligible late fee as a real, ledger-backed
   * Adjustment. Same role gate as manual Adjustment creation above (both
   * are financial corrections with the same real-money consequence).
   * `FinanceService.applyLateFee` verifies the ChargeItem belongs to BOTH
   * this building AND this unit before anything else.
   */
  @Post(':id/units/:unitId/charge-items/:chargeItemId/late-fee')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'MANAGER')
  applyLateFee(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Param('chargeItemId') chargeItemId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.applyLateFee(id, unitId, chargeItemId, user.sub, requestId);
  }

  // --- Payments --------------------------------------------------------------------

  /**
   * Finance Hardening Pass — paginated, see `listFunds`'s own doc comment.
   * Backend ↔ Mobile Contract Alignment — optional `?status=` filter added
   * so the mobile Pending Payments reviewer queue (`pendingPaymentsProvider`
   * → this route with `status=PENDING_APPROVAL`) gets a paginated window
   * that actually contains only pending payments, instead of a window of
   * "any status, most recent first" that a client-side filter then dilutes
   * — the exact gap that let a still-pending payment fall off page 1 once
   * ~20 payments of *any* status had been reported more recently. An
   * unrecognized `status` value 400s rather than silently falling back to
   * "no filter" (unlike `page`/`limit`, which are display-only and safe to
   * default): silently ignoring a typo'd status filter here would return
   * to exactly the dilution bug this filter exists to close. No new
   * migration — `Payment` already carries `@@index([buildingId, status])`.
   */
  @Get(':id/payments')
  @UseGuards(MembershipGuard)
  async listPayments(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    if (status !== undefined && !VALID_PAYMENT_STATUSES.includes(status)) {
      throw new ValidationError(
        `Invalid status filter. Valid values: ${VALID_PAYMENT_STATUSES.join(', ')}`,
      );
    }
    const { items, meta } = await this.finance.listPayments(
      id,
      parsePagination(page, limit),
      status as PaymentStatus | undefined,
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
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

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  @Get(':id/payments/:paymentId/refunds')
  @UseGuards(MembershipGuard)
  async listPaymentRefunds(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listPaymentRefunds(
      id,
      paymentId,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  // --- Expenses / Disbursements (FIN-EXP-01/FIN-EXP-02 -- see 21_ADRs > ADR-126) ---
  // Money the building SPENT -- distinct from Charge (money units owe) and
  // Payment (money received). Same write/read role split as Adjustment
  // create and Payment reverse/refund: MANAGER and ACCOUNTANT write,
  // any current member reads.

  @Post(':id/expenses')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  createExpense(
    @Param('id') id: string,
    @Body() dto: CreateExpenseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.createExpense(id, dto, user.sub, requestId);
  }

  @Get(':id/expenses')
  @UseGuards(MembershipGuard)
  async listExpenses(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('fundId') fundId?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    if (category !== undefined && !VALID_EXPENSE_CATEGORIES.includes(category)) {
      throw new ValidationError(
        `Invalid category filter. Valid values: ${VALID_EXPENSE_CATEGORIES.join(', ')}`,
      );
    }
    if (status !== undefined && !VALID_EXPENSE_STATUSES.includes(status)) {
      throw new ValidationError(
        `Invalid status filter. Valid values: ${VALID_EXPENSE_STATUSES.join(', ')}`,
      );
    }
    const { items, meta } = await this.finance.listExpenses(id, parsePagination(page, limit), {
      fundId,
      category: category as ExpenseCategory | undefined,
      status: status as ExpenseStatus | undefined,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    });
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':id/expenses/:expenseId')
  @UseGuards(MembershipGuard)
  getExpense(@Param('id') id: string, @Param('expenseId') expenseId: string) {
    return this.finance.getExpense(id, expenseId);
  }

  @Post(':id/expenses/:expenseId/void')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  voidExpense(
    @Param('id') id: string,
    @Param('expenseId') expenseId: string,
    @Body() dto: VoidExpenseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.finance.voidExpense(id, expenseId, dto, user.sub, requestId);
  }

  // --- Reporting -----------------------------------------------------------------

  @Get(':id/financial-summary')
  @UseGuards(MembershipGuard)
  getFinancialSummary(@Param('id') id: string) {
    return this.finance.getFinancialSummary(id);
  }

  /** Finance Hardening Pass — paginated, see `listFunds`'s own doc comment. */
  @Get(':id/ledger')
  @UseGuards(MembershipGuard)
  async listLedger(
    @Param('id') id: string,
    @Query('fundId') fundId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.finance.listLedger(id, fundId, parsePagination(page, limit));
    return withEnvelope(items, { metadata: { pagination: meta } });
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
