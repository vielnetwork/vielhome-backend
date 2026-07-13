import { Module } from '@nestjs/common';
import { MarketplaceController } from './controller/marketplace.controller';
import { MarketplaceModerationController } from './controller/marketplace-moderation.controller';
import { MarketplaceService } from './application/marketplace.service';
import { MarketplaceRepository } from './infrastructure/repositories/marketplace.repository';
import { ServiceProviderPolicy } from './domain/policies/service-provider.policy';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { BackOfficeModule } from '../backoffice/backoffice.module';

@Module({
  // Imports BackOfficeModule, NOT BuildingModule — the first domain in this
  // series to do so (every prior domain only ever imported BuildingModule).
  // Marketplace listings aren't building-scoped (see schema.prisma header
  // comment), so there's no BuildingRepository need; what this domain DOES
  // need is the platform-staff authorization primitive (`PlatformRolesGuard`
  // + the `BackOfficeRepository` it depends on) that ADR-029 already built
  // for exactly this purpose ("Marketplace Moderation" was BackOffice's own
  // named Future Module) — reusing it via import is more honest than
  // duplicating platform-staff lookup logic in a second place. See ADR-030
  // Decision for the full reasoning on this being a deliberate, narrow
  // exception to the "only import BuildingModule" convention.
  imports: [BackOfficeModule],
  controllers: [MarketplaceController, MarketplaceModerationController],
  providers: [MarketplaceService, MarketplaceRepository, ServiceProviderPolicy, PlatformRolesGuard],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
