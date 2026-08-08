import { Injectable } from '@nestjs/common';
import type { AdCampaign, AdCampaignStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * Monetization & Advertising — Phase 3 (Backend/Domain Foundation). Thin
 * Prisma wrapper for `AdCampaign` — same "no business logic here, just
 * queries" shape as `PlatformStaffRepository`. Validation, lifecycle
 * rules, and audit recording all live in `AdCampaignService`.
 */
@Injectable()
export class AdCampaignRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AdCampaignCreateInput): Promise<AdCampaign> {
    return this.prisma.adCampaign.create({ data });
  }

  findById(id: string): Promise<AdCampaign | null> {
    return this.prisma.adCampaign.findUnique({ where: { id } });
  }

  updateStatus(id: string, status: AdCampaignStatus): Promise<AdCampaign> {
    return this.prisma.adCampaign.update({ where: { id }, data: { status } });
  }

  buildingExists(buildingId: string): Promise<{ id: string } | null> {
    return this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true },
    });
  }
}
