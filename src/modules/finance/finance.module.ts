import { Module } from '@nestjs/common';
import { FinanceController } from './controller/finance.controller';
import { FinanceService } from './application/finance.service';
import { FinanceRepository } from './infrastructure/repositories/finance.repository';
import { ChargePolicy } from './domain/policies/charge.policy';
import { PaymentPolicy } from './domain/policies/payment.policy';
import { FundPolicy } from './domain/policies/fund.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BuildingModule } from '../building/building.module';

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
    MembershipGuard,
    RolesGuard,
  ],
  exports: [FinanceService, FinanceRepository],
})
export class FinanceModule {}
