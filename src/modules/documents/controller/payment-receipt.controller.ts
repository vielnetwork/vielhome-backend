import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaymentReceiptService } from '../application/payment-receipt.service';
import { RequestPaymentReceiptUploadIntentDto } from '../application/dto/request-payment-receipt-upload-intent.dto';
import { FinalizePaymentReceiptDto } from '../application/dto/finalize-payment-receipt.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * FIN-REC-01B — payment-receipt upload/finalize/download, routed under
 * the same `buildings/:id/payments/:paymentId/...` path family
 * `FinanceController` already uses for approve/reject/reverse/refund
 * (Nest resolves routes by full path across controllers — same "no
 * literal segment collision" argument used since ADR-023; `receipt` is a
 * new segment). Lives in the Documents module, not Finance — see
 * `PaymentReceiptService`'s own doc comment for why (avoids a circular
 * module dependency; no `forwardRef` needed).
 *
 * `MembershipGuard` only, never `RolesGuard`: payer-or-finance-reviewer is
 * a narrower, payment-specific rule than any single role (the payer may
 * hold no privileged role at all) — real authorization happens entirely
 * inside `PaymentReceiptService`/`FinanceService.getPaymentForViewer`, the
 * same "route guard proves membership, the service proves the real rule"
 * split `DocumentsService`'s own inline `assertMember` checks already use
 * on its building-less routes.
 */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class PaymentReceiptController {
  constructor(private readonly receipts: PaymentReceiptService) {}

  @Post(':id/payments/:paymentId/receipt/upload-intent')
  @UseGuards(MembershipGuard)
  @ApiOperation({
    summary: 'Request a presigned upload URL for a payment receipt.',
    description:
      'Payer of this payment, or a Manager/Accountant of this building, only. The payment must use method=BANK_TRANSFER (receipts are not supported for CASH payments) and must not already have a finalized receipt. Supported file types: PDF, JPG, JPEG, PNG. Maximum size: 25MB.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Presigned uploadUrl, storageKey, expiresAt, and uploadIntentId to pass to finalize.',
  })
  requestUploadIntent(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RequestPaymentReceiptUploadIntentDto,
  ) {
    return this.receipts.requestUploadIntent(id, paymentId, dto, user.sub);
  }

  @Post(':id/payments/:paymentId/receipt/finalize')
  @UseGuards(MembershipGuard)
  @ApiOperation({
    summary: 'Finalize an uploaded payment receipt.',
    description:
      "Identifies the uploaded file by uploadIntentId only (never a client-supplied storage key). Verifies the object's real file signature (PDF/PNG/JPEG magic bytes) matches its declared type before recording the receipt — an object that fails this check is deleted from storage and never recorded. Exactly one finalized receipt is allowed per payment.",
  })
  @ApiResponse({
    status: 201,
    description: 'Compact receipt metadata: id, filename, contentType, size, createdAt.',
  })
  finalize(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: FinalizePaymentReceiptDto,
    @RequestId() requestId: string,
  ) {
    return this.receipts.finalize(id, paymentId, dto, user.sub, requestId);
  }

  @Get(':id/payments/:paymentId/receipt/download')
  @UseGuards(MembershipGuard)
  @ApiOperation({
    summary: "Get a time-limited download URL for a payment's finalized receipt.",
    description: 'Payer of this payment, or a Manager/Accountant of this building, only.',
  })
  @ApiResponse({ status: 200, description: 'Presigned fileUrl, fileName, fileType.' })
  download(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.receipts.download(id, paymentId, user.sub, requestId);
  }
}
