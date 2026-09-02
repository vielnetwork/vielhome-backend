import { AdCampaignRepository } from './ad-campaign.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

function makePrisma() {
  return {
    adCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    adSlot: { findMany: jest.fn().mockResolvedValue([]) },
    building: { findUnique: jest.fn() },
  };
}

describe('AdCampaignRepository', () => {
  describe('findEligibleForPlacement', () => {
    it('orders by explicit slot position and never by priority', async () => {
      const prisma = makePrisma();
      const repository = new AdCampaignRepository(prisma as unknown as PrismaService);
      const now = new Date('2026-08-15T00:00:00.000Z');

      await repository.findEligibleForPlacement({
        placement: 'HOME_TODAY_OFFERS',
        now,
        buildingId: 'bldg-1',
        country: 'DE',
        city: 'Berlin',
        limit: 10,
      });

      expect(prisma.adCampaign.findMany).toHaveBeenCalledWith({
        where: {
          placement: 'HOME_TODAY_OFFERS',
          adSlotId: { not: null },
          status: 'ACTIVE',
          startsAt: { lte: now },
          endsAt: { gte: now },
          AND: [
            { OR: [{ targetCountry: null }, { targetCountry: 'DE' }] },
            { OR: [{ targetCity: null }, { targetCity: 'Berlin' }] },
            { OR: [{ buildingId: null }, { buildingId: 'bldg-1' }] },
          ],
        },
        orderBy: [
          { adSlot: { position: 'asc' } },
          { adSlot: { code: 'asc' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        take: 10,
        include: { adSlot: true },
      });
    });
  });

  describe('findInterstitialCandidates', () => {
    it('uses global-only targeting without building context and deterministic tie ordering', async () => {
      const prisma = makePrisma();
      const repository = new AdCampaignRepository(prisma as unknown as PrismaService);
      const now = new Date('2026-08-15T00:00:00.000Z');
      await repository.findInterstitialCandidates({ placement: 'HOME_INTERSTITIAL', now });
      expect(prisma.adCampaign.findMany).toHaveBeenCalledWith({
        where: {
          source: 'DIRECT',
          placement: 'HOME_INTERSTITIAL',
          status: 'ACTIVE',
          startsAt: { lte: now },
          endsAt: { gte: now },
          AND: [{ targetCountry: null }, { targetCity: null }, { buildingId: null }],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: { adSlot: true },
      });
    });

    it('matches each authoritative targeting dimension with building context', async () => {
      const prisma = makePrisma();
      const repository = new AdCampaignRepository(prisma as unknown as PrismaService);
      const now = new Date('2026-08-15T00:00:00.000Z');
      await repository.findInterstitialCandidates({
        placement: 'PAYMENT_ENTRY_INTERSTITIAL',
        now,
        buildingId: 'building-1',
        country: 'IR',
        city: 'Tehran',
      });
      expect(prisma.adCampaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            source: 'DIRECT',
            placement: 'PAYMENT_ENTRY_INTERSTITIAL',
            AND: [
              { OR: [{ targetCountry: null }, { targetCountry: 'IR' }] },
              { OR: [{ targetCity: null }, { targetCity: 'Tehran' }] },
              { OR: [{ buildingId: null }, { buildingId: 'building-1' }] },
            ],
          }),
        }),
      );
    });
  });

  it('lists slots in stable page/zone/position order', async () => {
    const prisma = makePrisma();
    const repository = new AdCampaignRepository(prisma as unknown as PrismaService);
    await repository.listSlots({ page: 'HOME', active: true });
    expect(prisma.adSlot.findMany).toHaveBeenCalledWith({
      where: { page: 'HOME', zone: undefined, isActive: true },
      orderBy: [{ page: 'asc' }, { zone: 'asc' }, { position: 'asc' }, { code: 'asc' }],
    });
  });

  describe('findBuildingGeography', () => {
    it('selects only country/city', async () => {
      const prisma = makePrisma();
      const repository = new AdCampaignRepository(prisma as unknown as PrismaService);

      await repository.findBuildingGeography('bldg-1');

      expect(prisma.building.findUnique).toHaveBeenCalledWith({
        where: { id: 'bldg-1' },
        select: { country: true, city: true },
      });
    });
  });
});
