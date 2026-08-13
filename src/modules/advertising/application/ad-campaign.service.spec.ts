import { AdCampaignService, CreateAdCampaignInput } from './ad-campaign.service';
import { AdCampaignRepository } from '../infrastructure/repositories/ad-campaign.repository';
import { AuditService } from '../../../common/audit/audit.service';
import {
  BusinessRuleViolationError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import type { AdCampaign } from '@prisma/client';

function makeRepository(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    updateStatus: jest.fn(),
    buildingExists: jest.fn().mockResolvedValue(null),
    findBuildingGeography: jest.fn().mockResolvedValue(null),
    findEligibleForPlacement: jest.fn().mockResolvedValue([]),
    listAdmin: jest.fn(),
    update: jest.fn(),
    ...overrides,
  } as unknown as AdCampaignRepository;
}

function makeAudit(): AuditService {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

function baseInput(overrides: Partial<CreateAdCampaignInput> = {}): CreateAdCampaignInput {
  return {
    name: 'Summer promo',
    source: 'DIRECT',
    placement: 'HOME_TODAY_OFFERS',
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-08-31T00:00:00.000Z'),
    title: 'Summer deals',
    imageUrl: 'https://cdn.example.com/summer.png',
    ...overrides,
  };
}

function campaignFixture(overrides: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: 'camp-1',
    name: 'Summer promo',
    status: 'DRAFT',
    source: 'DIRECT',
    placement: 'HOME_TODAY_OFFERS',
    priority: 0,
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-08-31T00:00:00.000Z'),
    title: 'Summer deals',
    description: null,
    imageUrl: 'https://cdn.example.com/summer.png',
    ctaLabel: null,
    ctaUrl: null,
    targetCountry: null,
    targetCity: null,
    buildingId: null,
    createdById: 'staff-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  } as AdCampaign;
}

describe('AdCampaignService', () => {
  describe('createCampaign', () => {
    it('creates a valid campaign, defaults priority to 0, and audits creation', async () => {
      const repository = makeRepository({
        create: jest.fn().mockResolvedValue(campaignFixture()),
      });
      const audit = makeAudit();
      const service = new AdCampaignService(repository, audit);

      const result = await service.createCampaign(baseInput(), 'staff-1', 'req-1');

      expect(result.id).toBe('camp-1');
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Summer promo', priority: 0 }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AdCampaignCreated',
          entityType: 'AdCampaign',
          entityId: 'camp-1',
          actorId: 'staff-1',
        }),
      );
    });

    it('rejects an invalid date range (endsAt not after startsAt)', async () => {
      const repository = makeRepository();
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.createCampaign(
          baseInput({
            startsAt: new Date('2026-08-31T00:00:00.000Z'),
            endsAt: new Date('2026-08-01T00:00:00.000Z'),
          }),
          'staff-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a negative priority', async () => {
      const repository = makeRepository();
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.createCampaign(baseInput({ priority: -1 }), 'staff-1', 'req-1'),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects an unrecognized source (provider/source validation)', async () => {
      const repository = makeRepository();
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.createCampaign(
          baseInput({ source: 'ADMOB' as CreateAdCampaignInput['source'] }),
          'staff-1',
          'req-1',
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects targeting a building that does not exist (targeting validation)', async () => {
      const repository = makeRepository({ buildingExists: jest.fn().mockResolvedValue(null) });
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.createCampaign(baseInput({ buildingId: 'no-such-building' }), 'staff-1', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('accepts a real building for building-specific targeting', async () => {
      const repository = makeRepository({
        buildingExists: jest.fn().mockResolvedValue({ id: 'bldg-1' }),
        create: jest.fn().mockResolvedValue(campaignFixture({ buildingId: 'bldg-1' })),
      });
      const audit = makeAudit();
      const service = new AdCampaignService(repository, audit);

      await service.createCampaign(baseInput({ buildingId: 'bldg-1' }), 'staff-1', 'req-1');

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ building: { connect: { id: 'bldg-1' } } }),
      );
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ buildingId: 'bldg-1' }));
    });
  });

  describe('transitionStatus (lifecycle)', () => {
    it('allows DRAFT -> ACTIVE and audits the transition', async () => {
      const draft = campaignFixture({ status: 'DRAFT' });
      const activated = campaignFixture({ status: 'ACTIVE' });
      const repository = makeRepository({
        findById: jest.fn().mockResolvedValue(draft),
        updateStatus: jest.fn().mockResolvedValue(activated),
      });
      const audit = makeAudit();
      const service = new AdCampaignService(repository, audit);

      const result = await service.transitionStatus('camp-1', 'ACTIVE', 'staff-1', 'req-1');

      expect(result.status).toBe('ACTIVE');
      expect(repository.updateStatus).toHaveBeenCalledWith('camp-1', 'ACTIVE');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AdCampaignStatusChanged',
          metadata: { before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } },
        }),
      );
    });

    it('rejects ENDED -> ACTIVE (terminal state) without touching the repository update', async () => {
      const ended = campaignFixture({ status: 'ENDED' });
      const repository = makeRepository({ findById: jest.fn().mockResolvedValue(ended) });
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.transitionStatus('camp-1', 'ACTIVE', 'staff-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppError for a campaign that does not exist', async () => {
      const repository = makeRepository({ findById: jest.fn().mockResolvedValue(null) });
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.transitionStatus('missing', 'ACTIVE', 'staff-1', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('admin reads and update', () => {
    it('passes filters and pagination to the repository and returns campaign detail', async () => {
      const page = {
        items: [campaignFixture()],
        meta: { page: 2, limit: 5, total: 6, totalPages: 2 },
      };
      const repository = makeRepository({
        listAdmin: jest.fn().mockResolvedValue(page),
        findById: jest.fn().mockResolvedValue(campaignFixture()),
      });
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.listCampaigns({ status: 'DRAFT', buildingId: 'bldg-1' }, { page: 2, limit: 5 }),
      ).resolves.toBe(page);
      await expect(service.getCampaign('camp-1')).resolves.toMatchObject({ id: 'camp-1' });
      expect(repository.listAdmin).toHaveBeenCalledWith(
        { status: 'DRAFT', buildingId: 'bldg-1' },
        { page: 2, limit: 5 },
      );
    });

    it('updates mutable fields through full domain validation and audits before/after', async () => {
      const current = campaignFixture();
      const updated = campaignFixture({ title: 'Updated', priority: 3, buildingId: 'bldg-2' });
      const repository = makeRepository({
        findById: jest.fn().mockResolvedValue(current),
        buildingExists: jest.fn().mockResolvedValue({ id: 'bldg-2' }),
        update: jest.fn().mockResolvedValue(updated),
      });
      const audit = makeAudit();
      const service = new AdCampaignService(repository, audit);

      await expect(
        service.updateCampaign(
          'camp-1',
          { title: 'Updated', priority: 3, buildingId: 'bldg-2' },
          'staff-1',
          'req-2',
        ),
      ).resolves.toBe(updated);
      expect(repository.update).toHaveBeenCalledWith(
        'camp-1',
        expect.objectContaining({
          title: 'Updated',
          priority: 3,
          building: { connect: { id: 'bldg-2' } },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AdCampaignUpdated',
          actorId: 'staff-1',
          requestId: 'req-2',
        }),
      );
    });

    it('rejects an update that makes the schedule invalid or targets a missing building', async () => {
      const repository = makeRepository({
        findById: jest.fn().mockResolvedValue(campaignFixture()),
      });
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.updateCampaign('camp-1', { endsAt: new Date('2026-07-01') }, 'staff-1', 'req'),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        service.updateCampaign('camp-1', { buildingId: 'missing' }, 'staff-1', 'req'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('isEligibleNow', () => {
    const service = new AdCampaignService(makeRepository(), makeAudit());
    const now = new Date('2026-08-15T00:00:00.000Z');

    it('is eligible when ACTIVE, in-schedule, placement matches, and untargeted', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS' })).toBe(true);
    });

    it('excludes a DRAFT campaign', () => {
      const campaign = campaignFixture({ status: 'DRAFT' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS' })).toBe(false);
    });

    it('excludes a PAUSED campaign', () => {
      const campaign = campaignFixture({ status: 'PAUSED' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS' })).toBe(false);
    });

    it('excludes an ENDED campaign', () => {
      const campaign = campaignFixture({ status: 'ENDED' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS' })).toBe(false);
    });

    it('excludes a campaign before its startsAt', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      const before = new Date('2026-07-15T00:00:00.000Z');
      expect(service.isEligibleNow(campaign, { now: before, placement: 'HOME_TODAY_OFFERS' })).toBe(
        false,
      );
    });

    it('excludes a campaign after its endsAt', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      const after = new Date('2026-09-15T00:00:00.000Z');
      expect(service.isEligibleNow(campaign, { now: after, placement: 'HOME_TODAY_OFFERS' })).toBe(
        false,
      );
    });

    it('is not eligible for a mismatched placement', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_FEATURED_LARGE' })).toBe(
        false,
      );
    });

    it('enforces country/city targeting when the campaign sets it (targeting isolation)', () => {
      const campaign = campaignFixture({
        status: 'ACTIVE',
        targetCountry: 'DE',
        targetCity: 'Berlin',
      });
      expect(
        service.isEligibleNow(campaign, {
          now,
          placement: 'HOME_TODAY_OFFERS',
          country: 'DE',
          city: 'Berlin',
        }),
      ).toBe(true);
      expect(
        service.isEligibleNow(campaign, {
          now,
          placement: 'HOME_TODAY_OFFERS',
          country: 'FR',
          city: 'Paris',
        }),
      ).toBe(false);
    });

    it('enforces building-specific targeting when the campaign sets it (targeting isolation)', () => {
      const campaign = campaignFixture({ status: 'ACTIVE', buildingId: 'bldg-1' });
      expect(
        service.isEligibleNow(campaign, {
          now,
          placement: 'HOME_TODAY_OFFERS',
          buildingId: 'bldg-1',
        }),
      ).toBe(true);
      expect(
        service.isEligibleNow(campaign, {
          now,
          placement: 'HOME_TODAY_OFFERS',
          buildingId: 'bldg-2',
        }),
      ).toBe(false);
    });
  });

  describe('getPlacementInventory (Phase 4 delivery)', () => {
    const now = new Date('2026-08-15T00:00:00.000Z');

    it('rejects an unrecognized placement without touching the repository', async () => {
      const repository = makeRepository();
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.getPlacementInventory('bldg-1', 'NOT_A_REAL_PLACEMENT', now),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(repository.findBuildingGeography).not.toHaveBeenCalled();
    });

    it('throws NotFoundAppError when the building does not exist', async () => {
      const repository = makeRepository({
        findBuildingGeography: jest.fn().mockResolvedValue(null),
      });
      const service = new AdCampaignService(repository, makeAudit());

      await expect(
        service.getPlacementInventory('missing-bldg', 'HOME_TODAY_OFFERS', now),
      ).rejects.toBeInstanceOf(NotFoundAppError);
    });

    it('queries the repository with the building geography and returns a provider-neutral, mapped response', async () => {
      const repository = makeRepository({
        findBuildingGeography: jest.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' }),
        findEligibleForPlacement: jest.fn().mockResolvedValue([
          campaignFixture({
            id: 'camp-a',
            status: 'ACTIVE',
            source: 'DIRECT',
            title: 'A',
            ctaLabel: 'Go',
            ctaUrl: 'https://a.example.com',
          }),
        ]),
      });
      const service = new AdCampaignService(repository, makeAudit());

      const result = await service.getPlacementInventory('bldg-1', 'HOME_TODAY_OFFERS', now);

      expect(repository.findEligibleForPlacement).toHaveBeenCalledWith({
        placement: 'HOME_TODAY_OFFERS',
        now,
        buildingId: 'bldg-1',
        country: 'DE',
        city: 'Berlin',
        limit: 10,
      });
      expect(result).toEqual({
        placement: 'HOME_TODAY_OFFERS',
        items: [
          {
            id: 'camp-a',
            source: 'DIRECT',
            title: 'A',
            description: null,
            imageUrl: 'https://cdn.example.com/summer.png',
            ctaLabel: 'Go',
            ctaUrl: 'https://a.example.com',
            sponsored: true,
          },
        ],
      });
      // Never exposes internal/audit fields.
      expect(result.items[0]).not.toHaveProperty('createdById');
      expect(result.items[0]).not.toHaveProperty('priority');
      expect(result.items[0]).not.toHaveProperty('status');
    });

    it('returns a successful empty-items response when nothing is eligible — not an error', async () => {
      const repository = makeRepository({
        findBuildingGeography: jest.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' }),
        findEligibleForPlacement: jest.fn().mockResolvedValue([]),
      });
      const service = new AdCampaignService(repository, makeAudit());

      const result = await service.getPlacementInventory('bldg-1', 'HOME_TODAY_OFFERS', now);

      expect(result).toEqual({ placement: 'HOME_TODAY_OFFERS', items: [] });
    });

    it('applies isEligibleNow as a safety net over the repository result (defense in depth)', async () => {
      // Simulates a query/rule mismatch: repository returns a candidate that
      // is not actually eligible (wrong placement) — the service must still
      // exclude it rather than trust the query blindly.
      const repository = makeRepository({
        findBuildingGeography: jest.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' }),
        findEligibleForPlacement: jest.fn().mockResolvedValue([
          campaignFixture({
            id: 'camp-wrong',
            status: 'ACTIVE',
            placement: 'HOME_FEATURED_LARGE',
          }),
        ]),
      });
      const service = new AdCampaignService(repository, makeAudit());

      const result = await service.getPlacementInventory('bldg-1', 'HOME_TODAY_OFFERS', now);

      expect(result.items).toEqual([]);
    });

    it('preserves the repository-provided ordering (priority DESC, then stable tie-breaker) without re-sorting', async () => {
      const repository = makeRepository({
        findBuildingGeography: jest.fn().mockResolvedValue({ country: 'DE', city: 'Berlin' }),
        findEligibleForPlacement: jest
          .fn()
          .mockResolvedValue([
            campaignFixture({ id: 'camp-high', status: 'ACTIVE', priority: 10 }),
            campaignFixture({ id: 'camp-mid', status: 'ACTIVE', priority: 5 }),
            campaignFixture({ id: 'camp-low', status: 'ACTIVE', priority: 0 }),
          ]),
      });
      const service = new AdCampaignService(repository, makeAudit());

      const result = await service.getPlacementInventory('bldg-1', 'HOME_TODAY_OFFERS', now);

      expect(result.items.map((i) => i.id)).toEqual(['camp-high', 'camp-mid', 'camp-low']);
    });
  });
});
