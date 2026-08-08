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
          baseInput({ startsAt: new Date('2026-08-31T00:00:00.000Z'), endsAt: new Date('2026-08-01T00:00:00.000Z') }),
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

  describe('isEligibleNow', () => {
    const service = new AdCampaignService(makeRepository(), makeAudit());
    const now = new Date('2026-08-15T00:00:00.000Z');

    it('is eligible when ACTIVE, in-schedule, placement matches, and untargeted', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS' })).toBe(true);
    });

    it('is not eligible when PAUSED', () => {
      const campaign = campaignFixture({ status: 'PAUSED' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS' })).toBe(false);
    });

    it('is not eligible outside the schedule window', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      const outside = new Date('2026-09-15T00:00:00.000Z');
      expect(service.isEligibleNow(campaign, { now: outside, placement: 'HOME_TODAY_OFFERS' })).toBe(false);
    });

    it('is not eligible for a mismatched placement', () => {
      const campaign = campaignFixture({ status: 'ACTIVE' });
      expect(service.isEligibleNow(campaign, { now, placement: 'HOME_FEATURED_LARGE' })).toBe(false);
    });

    it('enforces country/city targeting when the campaign sets it (targeting isolation)', () => {
      const campaign = campaignFixture({ status: 'ACTIVE', targetCountry: 'DE', targetCity: 'Berlin' });
      expect(
        service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS', country: 'DE', city: 'Berlin' }),
      ).toBe(true);
      expect(
        service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS', country: 'FR', city: 'Paris' }),
      ).toBe(false);
    });

    it('enforces building-specific targeting when the campaign sets it (targeting isolation)', () => {
      const campaign = campaignFixture({ status: 'ACTIVE', buildingId: 'bldg-1' });
      expect(
        service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS', buildingId: 'bldg-1' }),
      ).toBe(true);
      expect(
        service.isEligibleNow(campaign, { now, placement: 'HOME_TODAY_OFFERS', buildingId: 'bldg-2' }),
      ).toBe(false);
    });
  });
});
