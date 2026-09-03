import { Module } from '@nestjs/common';
import { FinanceController } from './controller/finance.controller';
import { FinanceService } from './application/finance.service';
import { FinanceRepository } from './infrastructure/repositories/finance.repository';
import { ChargePolicy } from './domain/policies/charge.policy';
import { PaymentPolicy } from './domain/policies/payment.policy';
import { FundPolicy } from './domain/policies/fund.policy';
import { ExpensePolicy } from './domain/policies/expense.policy';
import { ChargeFundAlignmentPolicy } from './domain/policies/charge-fund-alignment.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BuildingModule } from '../building/building.module';
import { FinanceUnitReadGuard } from './application/finance-unit-read.guard';

@Module({
  // BuildingModule exports BuildingRepository (added for exactly this
  // reason during ADR-022) — Finance re-uses it for building/unit lookups
  // and role resolution instead of duplicating that logic.
  imports: [BuildingModule],
  controllers: [FinanceController],
  providers: [
    FinanceService,
    FinanceRepository,
    ChargePolicy,
    PaymentPolicy,
    FundPolicy,
    ExpensePolicy,
    ChargeFundAlignmentPolicy,
    MembershipGuard,
    RolesGuard,
    FinanceUnitReadGuard,
  ],
  exports: [FinanceService, FinanceRepository],
})
export class FinanceModule {}
