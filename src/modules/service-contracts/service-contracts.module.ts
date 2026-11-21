import { Module } from '@nestjs/common';
import { BuildingModule } from '../building/building.module';
import {
  BuildingServiceContractsController,
  MyServiceContractsController,
} from './controller/service-contracts.controller';
import { ServiceContractsService } from './application/service-contracts.service';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [BuildingModule],
  controllers: [BuildingServiceContractsController, MyServiceContractsController],
  providers: [ServiceContractsService, RolesGuard],
})
export class ServiceContractsModule {}
