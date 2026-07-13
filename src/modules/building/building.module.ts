import { Module } from '@nestjs/common';
import { BuildingController } from './controller/building.controller';
import { BuildingSetupService } from './application/building-setup.service';
import { BuildingService } from './application/building.service';
import { BuildingRepository } from './infrastructure/repositories/building.repository';
import { DraftRepository } from './infrastructure/repositories/draft.repository';
import { BuildingSetupPolicy } from './domain/policies/building-setup.policy';
import { ManagerAssignmentPolicy } from './domain/policies/manager-assignment.policy';
import { OwnershipTransferPolicy } from './domain/policies/ownership-transfer.policy';
import { TenancyPolicy } from './domain/policies/tenancy.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [BuildingController],
  providers: [
    BuildingSetupService,
    BuildingService,
    BuildingRepository,
    DraftRepository,
    BuildingSetupPolicy,
    ManagerAssignmentPolicy,
    OwnershipTransferPolicy,
    TenancyPolicy,
    MembershipGuard,
    RolesGuard,
  ],
  exports: [BuildingService, BuildingRepository],
})
export class BuildingModule {}
