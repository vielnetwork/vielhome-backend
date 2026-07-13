import { Module } from '@nestjs/common';
import { CasesController } from './controller/cases.controller';
import { CasesService } from './application/cases.service';
import { CaseRepository } from './infrastructure/repositories/case.repository';
import { CasePolicy } from './domain/policies/case.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BuildingModule } from '../building/building.module';

@Module({
  // Reuses BuildingRepository for building/unit lookups and role
  // resolution (assignee eligibility, privileged-role checks) — same
  // pattern as FinanceModule/GovernanceModule.
  imports: [BuildingModule],
  controllers: [CasesController],
  providers: [CasesService, CaseRepository, CasePolicy, MembershipGuard, RolesGuard],
  exports: [CasesService, CaseRepository],
})
export class CasesModule {}
