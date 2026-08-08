import { AdCampaignRepository } from './ad-campaign.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

function makePrisma() {
  return {
    adCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    building: { findUnique: jest.fn() },
  } as unknown as PrismaService;
}

describe('AdCampaignRepository', () => {
  describe('findEligibleForPlacement', () => {
    it('builds status/placement/schedule/targeting filters, priority-first deterministic ordering, and the limit — in one query', async () => {
      const prisma = makePrisma();
      const repository = new AdCampaignRepository(prisma);
      const now = new Date('2026-08-15T00:00:00.000Z');

      await repository.findEligibleForPlacement({
        placement: 'HOME_TODAY_OFFERS',
        now,
        buildingId: 'bldg-1',
        country: 'DE',
        city: 'Berlin',
        limit: 10,
      });

      expect((prisma as any).adCampaign.findMany).toHaveBeenCalledWith({
        where: {
          placement: 'HOME_TODAY_OFFERS',
          status: 'ACTIVE',
          startsAt: { lte: now },
          endsAt: { gte: now },
          AND: [
            { OR: [{ targetCountry: null }, { targetCountry: 'DE' }] },
            { OR: [{ targetCity: null }, { targetCity: 'Berlin' }] },
            { OR: [{ buildingId: null }, { buildingId: 'bldg-1' }] },
          ],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 10,
      });
    });
  });

  describe('findBuildingGeography', () => {
    it('selects only country/city', async () => {
      const prisma = makePrisma();
      const repository = new AdCampaignRepository(prisma);

      await repository.findBuildingGeography('bldg-1');

      expect((prisma as any).building.findUnique).toHaveBeenCalledWith({
        where: { id: 'bldg-1' },
        select: { country: true, city: true },
      });
    });
  });
});
