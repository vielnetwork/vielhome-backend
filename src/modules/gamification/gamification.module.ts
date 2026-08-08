import { Module } from '@nestjs/common';
import { GamificationController } from './controller/gamification.controller';
import { BuildingGamificationController } from './controller/building-gamification.controller';
import { GamificationAdministrationController } from './controller/gamification-administration.controller';
import { GamificationService } from './application/gamification.service';
import { GamificationAdministrationService } from './application/gamification-administration.service';
import { GamificationEventListener } from './application/gamification-event-listener.service';
import { GamificationRepository } from './infrastructure/repositories/gamification.repository';
import { GamificationPolicy } from './domain/policies/gamification.policy';
import { BuildingModule } from '../building/building.module';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';

@Module({
  // BuildingModule as before. `BackOfficeModule` is new as of ADR-047 —
  // the second domain (after Marketplace, ADR-030) to import it purely for
  // `PlatformRolesGuard`'s own `BackOfficeRepository` dependency, gating
  // the new staff-only `GET /gamification/analytics` route. `Gamification
  // EventListener` still reacts to events from Finance/Governance/Cases/
  // Auth via `import type` only (compile-time, no runtime DI dependency),
  // unchanged since ADR-023.
  // 21_ADRs > ADR-102 additionally imports `BackofficeRbacModule` for
  // `PermissionsGuard`, gating the single staff-only `GET /gamification/
  // analytics` route alongside the pre-existing `PlatformRolesGuard`. No
  // cycle risk: this module is never imported back into `BackOfficeModule`/
  // `BackofficeRbacModule`.
  // 21_ADRs > ADR-124 — `GamificationAdministrationController`/`...Service`
  // (the four Backoffice correction routes) also live here rather than in
  // `BackOfficeModule`, precisely to preserve that same "never imported
  // back" one-way graph — see `GamificationAdministrationService`'s own doc
  // comment.
  imports: [BuildingModule, BackOfficeModule, BackofficeRbacModule],
  controllers: [
    GamificationController,
    BuildingGamificationController,
    GamificationAdministrationController,
  ],
  providers: [
    GamificationService,
    GamificationAdministrationService,
    GamificationEventListener,
    GamificationRepository,
    GamificationPolicy,
    PlatformRolesGuard,
  ],
  exports: [GamificationService],
})
export class GamificationModule {}
