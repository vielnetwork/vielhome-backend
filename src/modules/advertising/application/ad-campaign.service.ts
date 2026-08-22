import { Injectable } from '@nestjs/common';
import type {
  AdCampaign,
  AdCampaignSource,
  AdCampaignStatus,
  AdPlacement,
  AdSlot,
} from '@prisma/client';
import { AdCampaignRepository } from '../infrastructure/repositories/ad-campaign.repository';
import type { AdminCampaignFilters } from '../infrastructure/repositories/ad-campaign.repository';
import type { AdCampaignWithSlot } from '../infrastructure/repositories/ad-campaign.repository';
import type { PaginationParams } from '../../../common/pagination/pagination.util';
import { AuditService } from '../../../common/audit/audit.service';
import {
  BusinessRuleViolationError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';

export interface CreateAdCampaignInput {
  name: string;
  source: AdCampaignSource;
  placement: AdPlacement;
  priority?: number;
  startsAt: Date;
  endsAt: Date;
  title: string;
  description?: string | null;
  imageUrl: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  targetCountry?: string | null;
  targetCity?: string | null;
  buildingId?: string | null;
  adSlotId: string;
}

export type UpdateAdCampaignInput = Partial<CreateAdCampaignInput>;

export interface EligibilityContext {
  now: Date;
  placement: AdPlacement;
  country?: string | null;
  city?: string | null;
  buildingId?: string | null;
}

export interface PlacementInventoryItem {
  id: string;
  source: AdCampaignSource;
  title: string;
  description: string | null;
  imageUrl: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  sponsored: true;
  slot: Pick<AdSlot, 'id' | 'code' | 'label' | 'zone' | 'position' | 'orientation'>;
}

export interface PlacementInventoryResponse {
  placement: AdPlacement;
  items: PlacementInventoryItem[];
}

const SOURCES: AdCampaignSource[] = ['DIRECT', 'MARKETPLACE', 'EXTERNAL'];
const PLACEMENTS: AdPlacement[] = [
  'HOME_SERVICES_CAROUSEL',
  'HOME_TODAY_OFFERS',
  'HOME_CONTENT_CAROUSEL',
  'HOME_FEATURED_LARGE',
];

/** Lifecycle transitions this phase allows. `ENDED` is terminal — no
 * transition out, matching "ended campaigns do not restart" (a new
 * campaign is created instead). */
const ALLOWED_TRANSITIONS: Record<AdCampaignStatus, AdCampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: [],
};

/** Phase 4 — a conservative cap appropriate for a Home carousel/offers
 * strip, not a paginated feed. One shared constant rather than
 * per-placement config: every approved placement is a small Home surface
 * with the same practical inventory ceiling; a future placement that
 * genuinely needs a different limit is a deliberate follow-up, not
 * something to speculatively generalize now. */
const MAX_PLACEMENT_ITEMS = 10;

const SLOT_ZONE_BY_PLACEMENT: Partial<Record<AdPlacement, string>> = {
  HOME_TODAY_OFFERS: 'N',
  HOME_FEATURED_LARGE: 'S',
};

/**
 * Monetization & Advertising — Phase 3/4 (Backend/Domain Foundation +
 * Delivery API). Validation, lifecycle transitions, and eligibility for
 * `AdCampaign` — no impression/click recording, no analytics, no
 * caching, no recommendation ranking; those are later phases. Every
 * mutation is audited, same "Who/When/What/Why" discipline
 * `ProviderSettingsService.setEnabled` already established.
 */
@Injectable()
export class AdCampaignService {
  constructor(
    private readonly repository: AdCampaignRepository,
    private readonly audit: AuditService,
  ) {}

  listCampaigns(filters: AdminCampaignFilters, pagination: PaginationParams) {
    return this.repository.listAdmin(filters, pagination);
  }

  listSlots(filters: { page?: string; zone?: string; active?: boolean }) {
    return this.repository.listSlots(filters);
  }

  async getCampaign(id: string): Promise<AdCampaignWithSlot> {
    const campaign = await this.repository.findById(id);
    if (!campaign) throw new NotFoundAppError('Campaign not found.');
    return campaign;
  }

  async createCampaign(
    input: CreateAdCampaignInput,
    actorId: string,
    requestId: string,
  ): Promise<AdCampaignWithSlot> {
    await this.assertValidCampaignInput(input);

    const campaign = await this.repository.create({
      name: input.name,
      source: input.source,
      placement: input.placement,
      priority: input.priority ?? 0,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      title: input.title,
      description: input.description ?? null,
      imageUrl: input.imageUrl,
      ctaLabel: input.ctaLabel ?? null,
      ctaUrl: input.ctaUrl ?? null,
      targetCountry: input.targetCountry ?? null,
      targetCity: input.targetCity ?? null,
      createdById: actorId,
      adSlot: { connect: { id: input.adSlotId } },
      ...(input.buildingId ? { building: { connect: { id: input.buildingId } } } : {}),
    });

    await this.audit.record({
      actorId,
      buildingId: input.buildingId ?? null,
      action: 'AdCampaignCreated',
      entityType: 'AdCampaign',
      entityId: campaign.id,
      requestId,
      metadata: { source: campaign.source, placement: campaign.placement, status: campaign.status },
    });

    return campaign;
  }

  async transitionStatus(
    id: string,
    targetStatus: AdCampaignStatus,
    actorId: string,
    requestId: string,
    reason?: string,
  ): Promise<AdCampaignWithSlot> {
    const campaign = await this.repository.findById(id);
    if (!campaign) {
      throw new NotFoundAppError('Campaign not found.');
    }

    const allowed = ALLOWED_TRANSITIONS[campaign.status] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new BusinessRuleViolationError(
        `Cannot transition campaign from ${campaign.status} to ${targetStatus}.`,
      );
    }

    const before = campaign.status;
    if (targetStatus === 'ACTIVE') {
      if (!campaign.adSlotId) throw new ValidationError('Campaign must reference an ad slot.');
      const conflict = await this.repository.findObviousSlotConflict(campaign);
      if (conflict) {
        throw new BusinessRuleViolationError(
          'Another active campaign targets this slot, building scope, and overlapping schedule.',
        );
      }
    }
    const updated = await this.repository.updateStatus(id, targetStatus);

    await this.audit.record({
      actorId,
      buildingId: updated.buildingId,
      action: 'AdCampaignStatusChanged',
      entityType: 'AdCampaign',
      entityId: updated.id,
      reason,
      requestId,
      metadata: { before: { status: before }, after: { status: updated.status } },
    });

    return updated;
  }

  async updateCampaign(
    id: string,
    input: UpdateAdCampaignInput,
    actorId: string,
    requestId: string,
  ): Promise<AdCampaignWithSlot> {
    const current = await this.getCampaign(id);
    const merged: CreateAdCampaignInput = {
      name: input.name ?? current.name,
      source: input.source ?? current.source,
      placement: input.placement ?? current.placement,
      priority: input.priority ?? current.priority,
      startsAt: input.startsAt ?? current.startsAt,
      endsAt: input.endsAt ?? current.endsAt,
      title: input.title ?? current.title,
      description: input.description === undefined ? current.description : input.description,
      imageUrl: input.imageUrl ?? current.imageUrl,
      ctaLabel: input.ctaLabel === undefined ? current.ctaLabel : input.ctaLabel,
      ctaUrl: input.ctaUrl === undefined ? current.ctaUrl : input.ctaUrl,
      targetCountry:
        input.targetCountry === undefined ? current.targetCountry : input.targetCountry,
      targetCity: input.targetCity === undefined ? current.targetCity : input.targetCity,
      buildingId: input.buildingId === undefined ? current.buildingId : input.buildingId,
      adSlotId: input.adSlotId ?? current.adSlotId ?? '',
    };
    await this.assertValidCampaignInput(merged);
    if (current.status === 'ACTIVE') {
      const conflict = await this.repository.findObviousSlotConflict({
        ...current,
        adSlotId: merged.adSlotId,
        buildingId: merged.buildingId ?? null,
        startsAt: merged.startsAt,
        endsAt: merged.endsAt,
      });
      if (conflict) {
        throw new BusinessRuleViolationError(
          'Another active campaign targets this slot, building scope, and overlapping schedule.',
        );
      }
    }
    const updated = await this.repository.update(id, {
      name: merged.name,
      source: merged.source,
      placement: merged.placement,
      priority: merged.priority,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      title: merged.title,
      description: merged.description,
      imageUrl: merged.imageUrl,
      ctaLabel: merged.ctaLabel,
      ctaUrl: merged.ctaUrl,
      targetCountry: merged.targetCountry,
      targetCity: merged.targetCity,
      building: merged.buildingId ? { connect: { id: merged.buildingId } } : { disconnect: true },
      adSlot: { connect: { id: merged.adSlotId } },
    });
    await this.audit.record({
      actorId,
      buildingId: updated.buildingId,
      action: 'AdCampaignUpdated',
      entityType: 'AdCampaign',
      entityId: updated.id,
      requestId,
      metadata: { before: current, after: updated },
    });
    return updated;
  }

  /**
   * Pure eligibility check — domain support for a delivery query, not a
   * delivery endpoint on its own. A campaign is eligible only when its
   * status is ACTIVE, `now` falls within its schedule, the placement
   * matches, and every targeting dimension the campaign sets either
   * matches the context or the campaign leaves that dimension untargeted
   * (null = no restriction).
   */
  isEligibleNow(campaign: AdCampaign, ctx: EligibilityContext): boolean {
    if (campaign.status !== 'ACTIVE') return false;
    if (campaign.placement !== ctx.placement) return false;
    if (ctx.now < campaign.startsAt || ctx.now > campaign.endsAt) return false;
    if (campaign.targetCountry && campaign.targetCountry !== ctx.country) return false;
    if (campaign.targetCity && campaign.targetCity !== ctx.city) return false;
    if (campaign.buildingId && campaign.buildingId !== ctx.buildingId) return false;
    return true;
  }

  /**
   * Phase 4 — Advertising Delivery API
   * (`GET /buildings/:id/advertising/placements/:placement`). The real
   * filtering/ordering/limit happens in
   * `AdCampaignRepository.findEligibleForPlacement` (efficient — Prisma
   * does the narrowing, not an in-memory scan of every campaign for the
   * placement). `isEligibleNow` then re-checks each already-narrow
   * candidate as a cheap correctness safety net — reusing the same
   * already-tested domain rule rather than trusting the query's
   * `WHERE`/`OR` shape to be bug-free, without re-deriving the rule
   * itself a second time. Returns a successful empty-`items` response
   * when nothing is eligible — never an error.
   */
  async getPlacementInventory(
    buildingId: string,
    placementInput: string,
    now: Date,
  ): Promise<PlacementInventoryResponse> {
    if (!PLACEMENTS.includes(placementInput as AdPlacement)) {
      throw new ValidationError(`Unknown placement: ${placementInput}.`);
    }
    const placement = placementInput as AdPlacement;

    const building = await this.repository.findBuildingGeography(buildingId);
    if (!building) {
      throw new NotFoundAppError('Building not found.');
    }

    const candidates = await this.repository.findEligibleForPlacement({
      placement,
      now,
      buildingId,
      country: building.country,
      city: building.city,
      limit: MAX_PLACEMENT_ITEMS,
    });

    const eligible = candidates.filter(
      (campaign) =>
        campaign.adSlot &&
        this.isEligibleNow(campaign, {
          now,
          placement,
          country: building.country,
          city: building.city,
          buildingId,
        }),
    );

    return {
      placement,
      items: eligible.map((campaign) => ({
        id: campaign.id,
        source: campaign.source,
        title: campaign.title,
        description: campaign.description,
        imageUrl: campaign.imageUrl,
        ctaLabel: campaign.ctaLabel,
        ctaUrl: campaign.ctaUrl,
        sponsored: true as const,
        slot: {
          id: campaign.adSlot!.id,
          code: campaign.adSlot!.code,
          label: campaign.adSlot!.label,
          zone: campaign.adSlot!.zone,
          position: campaign.adSlot!.position,
          orientation: campaign.adSlot!.orientation,
        },
      })),
    };
  }

  private async assertValidCampaignInput(input: CreateAdCampaignInput): Promise<void> {
    if (!SOURCES.includes(input.source)) {
      throw new ValidationError(`Unknown campaign source: ${input.source}.`);
    }
    if (!PLACEMENTS.includes(input.placement)) {
      throw new ValidationError(`Unknown campaign placement: ${input.placement}.`);
    }
    if (!(input.endsAt > input.startsAt)) {
      throw new ValidationError('endsAt must be after startsAt.');
    }
    if (input.priority !== undefined && input.priority < 0) {
      throw new ValidationError('priority must not be negative.');
    }
    const slot = await this.repository.findSlotById(input.adSlotId);
    if (!slot) throw new ValidationError('Unknown advertising slot.');
    if (!slot.isActive) throw new BusinessRuleViolationError('Advertising slot is inactive.');
    const expectedZone = SLOT_ZONE_BY_PLACEMENT[input.placement];
    if (!expectedZone || slot.page !== 'HOME' || slot.zone !== expectedZone) {
      throw new ValidationError('Advertising slot is not compatible with campaign placement.');
    }
    if (input.buildingId) {
      const building = await this.repository.buildingExists(input.buildingId);
      if (!building) {
        throw new NotFoundAppError('Targeted building not found.');
      }
    }
  }
}
