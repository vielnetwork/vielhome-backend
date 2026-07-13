import { Module } from '@nestjs/common';
import { GamificationController } from './controller/gamification.controller';
import { BuildingGamificationController } from './controller/building-gamification.controller';
import { GamificationService } from './application/gamification.service';
import { GamificationEventListener } from './application/gamification-event-listener.service';
import { GamificationRepository } from './infrastructure/repositories/gamification.repository';
import { GamificationPolicy } from './domain/policies/gamification.policy';
import { BuildingModule } from '../building/building.module';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';

@Module({
  // BuildingModule as before. `BackOfficeModule` is new as of ADR-047 —
  // the second domain (after Marketplace, ADR-030) to import it purely for
  // `PlatformRolesGuard`'s own `BackOfficeRepository` dependency, gating
  // the new staff-only `GET /gamification/analytics` route. `Gamification
  // EventListener` still reacts to events from Finance/Governance/Cases/
  // Auth via `import type` only (compile-time, no runtime DI dependency),
  // unchanged since ADR-023.
  imports: [BuildingModule, BackOfficeModule],
  controllers: [GamificationController, BuildingGamificationController],
  providers: [
    GamificationService,
    GamificationEventListener,
    GamificationRepository,
    GamificationPolicy,
    PlatformRolesGuard,
  ],
  exports: [GamificationService],
})
export class GamificationModule {}
