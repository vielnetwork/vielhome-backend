import { Module } from '@nestjs/common';
import { BuildingModule } from '../building/building.module';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { AdCampaignRepository } from './infrastructure/repositories/ad-campaign.repository';
import { AdCampaignService } from './application/ad-campaign.service';
import { AdvertisingDeliveryController } from './controller/advertising-delivery.controller';
import { AdvertisingAdministrationController } from './controller/advertising-administration.controller';
import { BackofficeRbacModule } from '../backoffice-rbac/backoffice-rbac.module';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { BackOfficeRepository } from '../backoffice/infrastructure/repositories/backoffice.repository';

/**
 * Monetization & Advertising — Phase 3/4 (Backend/Domain Foundation +
 * Delivery API). No admin/mutation controller yet — that's Phase 5.
 * `PrismaService`/`AuditService` need no import here — both
 * `PrismaModule` and `AuditModule` are `@Global()`.
 *
 * `MembershipGuard` (used by `AdvertisingDeliveryController`) is NOT
 * globally resolvable — a real local e2e run proved that guard classes
 * bound via `@UseGuards()` are constructed using THIS module's own
 * injector, so `MembershipGuard`'s own constructor dependency
 * (`BuildingRepository`) must be resolvable here, not just somewhere
 * else in the app. Fixed the same way `CasesModule`/`DocumentsModule`/
 * `FinanceModule`/`GovernanceModule`/`BackOfficeModule` already do it —
 * import `BuildingModule` (for its exported `BuildingRepository`) and
 * redeclare `MembershipGuard` as a local provider (the same guard class,
 * not a second implementation — Nest resolves its constructor from this
 * module's own import graph once redeclared here). Does NOT redeclare
 * `BuildingRepository` itself — it's already available via the
 * `BuildingModule` import's own export, so declaring it again here would
 * be the actual duplication this fix must avoid.
 */
@Module({
  imports: [BuildingModule, BackofficeRbacModule],
  controllers: [AdvertisingDeliveryController, AdvertisingAdministrationController],
  providers: [
    AdCampaignRepository,
    AdCampaignService,
    MembershipGuard,
    PlatformRolesGuard,
    BackOfficeRepository,
  ],
  exports: [AdCampaignService, AdCampaignRepository],
})
export class AdvertisingModule {}
