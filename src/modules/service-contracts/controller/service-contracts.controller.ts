import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { CreateServiceContractDto } from '../application/dto/create-service-contract.dto';
import { RejectServiceContractPaymentDto } from '../application/dto/reject-service-contract-payment.dto';
import { ReportServiceContractPaymentDto } from '../application/dto/report-service-contract-payment.dto';
import { ServiceContractsService } from '../application/service-contracts.service';

@ApiTags('service-contracts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class BuildingServiceContractsController {
  constructor(private readonly contracts: ServiceContractsService) {}

  @Post(':id/service-contracts')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  create(
    @Param('id') buildingId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateServiceContractDto,
    @RequestId() requestId: string,
  ) {
    return this.contracts.create(buildingId, dto, user.sub, requestId);
  }

  @Get(':id/service-contracts')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  listForBuilding(@Param('id') buildingId: string) {
    return this.contracts.listForBuilding(buildingId);
  }

  @Post(':id/service-contracts/:contractId/deposit/refund')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  refundDeposit(
    @Param('id') buildingId: string,
    @Param('contractId') contractId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.contracts.recordDeposit(buildingId, contractId, user.sub, requestId, true);
  }

  @Post(':id/service-contracts/:contractId/deposit/receive')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  receiveDeposit(
    @Param('id') buildingId: string,
    @Param('contractId') contractId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.contracts.recordDeposit(buildingId, contractId, user.sub, requestId, false);
  }

  @Post(':id/service-contracts/:contractId/end')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  end(
    @Param('id') buildingId: string,
    @Param('contractId') contractId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.contracts.end(buildingId, contractId, user.sub, requestId);
  }

  @Get(':id/service-contract-invoices')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  listInvoices(@Param('id') buildingId: string) {
    return this.contracts.listInvoicesForBuilding(buildingId);
  }

  @Post(':id/service-contract-payments/:paymentId/approve')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  approvePayment(
    @Param('id') buildingId: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.contracts.approvePayment(buildingId, paymentId, user.sub, requestId);
  }

  @Post(':id/service-contract-payments/:paymentId/reject')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'ACCOUNTANT')
  rejectPayment(
    @Param('id') buildingId: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: RejectServiceContractPaymentDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.contracts.rejectPayment(buildingId, paymentId, dto.reason, user.sub, requestId);
  }
}

/** Separate route because a service customer is intentionally not a member. */
@ApiTags('service-contracts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'service-contracts', version: '1' })
export class MyServiceContractsController {
  constructor(private readonly contracts: ServiceContractsService) {}

  @Get('mine')
  listMine(@CurrentUser() user: JwtPayload) {
    return this.contracts.listMine(user.sub);
  }

  @Get('invoices/mine')
  listMyInvoices(@CurrentUser() user: JwtPayload) {
    return this.contracts.listMyInvoices(user.sub);
  }

  @Post('invoices/:invoiceId/payments')
  reportPayment(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: ReportServiceContractPaymentDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.contracts.reportPayment(invoiceId, dto, user.sub, requestId);
  }
}
