import { Injectable } from '@nestjs/common';
import type {
  AdCampaign,
  AdCampaignSource,
  AdCampaignStatus,
  AdPlacement,
} from '@prisma/client';
import { AdCampaignRepository } from '../infrastructure/repositories/ad-campaign.repository';
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
}

export interface EligibilityContext {
  now: Date;
  placement: AdPlacement;
  country?: string | null;
  city?: string | null;
  buildingId?: string | null;
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

/**
 * Monetization & Advertising — Phase 3 (Backend/Domain Foundation).
 * Validation, lifecycle transitions, and eligibility for `AdCampaign` —
 * no delivery endpoint, no mobile rendering, no analytics pipeline; those
 * are later phases. Every mutation is audited, same "Who/When/What/Why"
 * discipline `ProviderSettingsService.setEnabled` already established.
 */
@Injectable()
export class AdCampaignService {
  constructor(
    private readonly repository: AdCampaignRepository,
    private readonly audit: AuditService,
  ) {}

  async createCampaign(
    input: CreateAdCampaignInput,
    actorId: string,
    requestId: string,
  ): Promise<AdCampaign> {
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
      ...(input.buildingId
        ? { building: { connect: { id: input.buildingId } } }
        : {}),
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
  ): Promise<AdCampaign> {
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

  /**
   * Pure eligibility check — domain support for a future delivery query,
   * not a delivery endpoint itself. A campaign is eligible only when its
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
    if (input.buildingId) {
      const building = await this.repository.buildingExists(input.buildingId);
      if (!building) {
        throw new NotFoundAppError('Targeted building not found.');
      }
    }
  }
}
