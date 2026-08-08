import { Module } from '@nestjs/common';
import { AdCampaignRepository } from './infrastructure/repositories/ad-campaign.repository';
import { AdCampaignService } from './application/ad-campaign.service';

/**
 * Monetization & Advertising — Phase 3 (Backend/Domain Foundation). No
 * controller yet — this module exists so `AdCampaignService` can be
 * injected once a Backoffice controller lands (Phase 5). `PrismaService`/
 * `AuditService` need no import here — both `PrismaModule` and
 * `AuditModule` are `@Global()`, same as every other module in this
 * codebase that only needs them.
 */
@Module({
  providers: [AdCampaignRepository, AdCampaignService],
  exports: [AdCampaignService, AdCampaignRepository],
})
export class AdvertisingModule {}
