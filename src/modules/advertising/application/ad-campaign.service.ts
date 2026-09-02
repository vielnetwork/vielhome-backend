import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AdCampaign,
  AdCampaignSource,
  AdCampaignStatus,
  AdExternalProvider,
  AdPlacement,
  AdPresentationFormat,
  AdSlot,
  AdSlotFillStrategy,
} from '@prisma/client';
import { AdCampaignRepository } from '../infrastructure/repositories/ad-campaign.repository';
import type { AdminCampaignFilters } from '../infrastructure/repositories/ad-campaign.repository';
import type { AdCampaignWithSlot } from '../infrastructure/repositories/ad-campaign.repository';
import type { PaginationParams } from '../../../common/pagination/pagination.util';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import {
  AuthorizationError,
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
  slots: Array<{
    slot: AdSlot;
    campaign: PlacementInventoryItem | null;
  }>;
}

export interface InterstitialInventoryResponse {
  placement: AdPlacement;
  winner:
    | (Omit<PlacementInventoryItem, 'slot'> & {
        slot: Pick<
          AdSlot,
          | 'id'
          | 'code'
          | 'placement'
          | 'presentationFormat'
          | 'minimumDisplaySeconds'
          | 'skippable'
          | 'maxPerSession'
        >;
      })
    | null;
}

export interface UpdateAdSlotFillInput {
  fillStrategy: AdSlotFillStrategy;
  externalProvider: AdExternalProvider;
  androidAdUnitId?: string | null;
  iosAdUnitId?: string | null;
  presentationFormat?: AdPresentationFormat;
  minimumDisplaySeconds?: number | null;
  skippable?: boolean | null;
  maxPerSession?: number | null;
}

const SOURCES: AdCampaignSource[] = ['DIRECT', 'MARKETPLACE', 'EXTERNAL'];
const PLACEMENTS: AdPlacement[] = [
  'HOME_SERVICES_CAROUSEL',
  'HOME_TODAY_OFFERS',
  'HOME_CONTENT_CAROUSEL',
  'HOME_FEATURED_LARGE',
  'HOME_INTERSTITIAL',
  'PAYMENT_ENTRY_INTERSTITIAL',
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

const INTERSTITIAL_PLACEMENTS: AdPlacement[] = ['HOME_INTERSTITIAL', 'PAYMENT_ENTRY_INTERSTITIAL'];
const INTERSTITIAL_SLOT_CODE: Record<'HOME_INTERSTITIAL' | 'PAYMENT_ENTRY_INTERSTITIAL', string> = {
  HOME_INTERSTITIAL: 'HOM-I-01',
  PAYMENT_ENTRY_INTERSTITIAL: 'PAY-I-01',
};

// Combinations inherit the most specific restriction actually present:
// building > city > country > no targeting.
const targetSpecificity = (campaign: AdCampaign): number =>
  campaign.buildingId ? 3 : campaign.targetCity ? 2 : campaign.targetCountry ? 1 : 0;

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
  private readonly logger = new Logger(AdCampaignService.name);
  constructor(
    private readonly repository: AdCampaignRepository,
    private readonly audit: AuditService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  requestCampaignImageUpload(input: {
    fileName: string;
    contentType: string;
    fileSize: number;
    campaignId?: string;
  }) {
    const storageKey = this.storage!.buildAdvertisingCampaignObjectKey(
      input.campaignId,
      input.fileName,
    );
    const upload = this.storage!.getPresignedUploadUrl(storageKey);
    return { ...upload, imageUrl: storageKey };
  }

  listCampaigns(filters: AdminCampaignFilters, pagination: PaginationParams) {
    return this.repository.listAdmin(filters, pagination);
  }

  listSlots(filters: { page?: string; zone?: string; active?: boolean }) {
    return this.repository.listSlots(filters);
  }

  async updateSlotFill(
    id: string,
    input: UpdateAdSlotFillInput,
    actorId: string,
    requestId: string,
  ) {
    const current = await this.repository.findSlotById(id);
    if (!current) throw new NotFoundAppError('Advertising slot not found.');
    const proposed = {
      ...current,
      ...input,
      androidAdUnitId: this.normalizeAdUnitId(input.androidAdUnitId ?? current.androidAdUnitId),
      iosAdUnitId: this.normalizeAdUnitId(input.iosAdUnitId ?? current.iosAdUnitId),
    };
    this.assertValidSlotFill(proposed);
    const updated = await this.repository.updateSlotFill(id, {
      fillStrategy: input.fillStrategy,
      externalProvider: input.externalProvider,
      androidAdUnitId: this.normalizeAdUnitId(input.androidAdUnitId),
      iosAdUnitId: this.normalizeAdUnitId(input.iosAdUnitId),
      ...(input.presentationFormat !== undefined
        ? { presentationFormat: input.presentationFormat }
        : {}),
      ...(input.minimumDisplaySeconds !== undefined
        ? { minimumDisplaySeconds: input.minimumDisplaySeconds }
        : {}),
      ...(input.skippable !== undefined ? { skippable: input.skippable } : {}),
      ...(input.maxPerSession !== undefined ? { maxPerSession: input.maxPerSession } : {}),
    });
    await this.audit.record({
      actorId,
      buildingId: null,
      action: 'AdSlotFillUpdated',
      entityType: 'AdSlot',
      entityId: id,
      requestId,
      metadata: { before: current, after: updated },
    });
    return updated;
  }

  async getCampaign(id: string): Promise<AdCampaignWithSlot & { imagePreviewUrl: string }> {
    const campaign = await this.repository.findById(id);
    if (!campaign) throw new NotFoundAppError('Campaign not found.');
    return { ...campaign, imagePreviewUrl: this.resolveCampaignImageUrl(campaign.imageUrl) };
  }

  async createCampaign(
    input: CreateAdCampaignInput,
    actorId: string,
    requestId: string,
  ): Promise<AdCampaignWithSlot> {
    await this.assertValidCampaignInput(input);
    await this.assertValidCampaignImageOrCleanup(input.imageUrl);

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
    if (input.imageUrl !== undefined && input.imageUrl !== current.imageUrl) {
      await this.assertValidCampaignImageOrCleanup(input.imageUrl);
    }
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
    if (updated.imageUrl !== current.imageUrl) {
      await this.cleanupReplacedCampaignImage(current.imageUrl);
    }
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

    const items = eligible.map((campaign) => ({
      id: campaign.id,
      source: campaign.source,
      title: campaign.title,
      description: campaign.description,
      imageUrl: this.resolveCampaignImageUrl(campaign.imageUrl),
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
    }));
    const zone = SLOT_ZONE_BY_PLACEMENT[placement];
    const slots = zone ? await this.repository.findActiveSlots('HOME', zone) : [];
    const campaignBySlot = new Map(items.map((item) => [item.slot.id, item]));

    return {
      placement,
      items,
      slots: slots.map((slot) => ({ slot, campaign: campaignBySlot.get(slot.id) ?? null })),
    };
  }

  async getInterstitialInventory(
    personId: string,
    placementInput: string,
    buildingId: string | undefined,
    now: Date,
  ): Promise<InterstitialInventoryResponse> {
    if (!INTERSTITIAL_PLACEMENTS.includes(placementInput as AdPlacement)) {
      throw new ValidationError(`Unsupported interstitial placement: ${placementInput}.`);
    }
    const placement = placementInput as AdPlacement;
    let geography: { country: string; city: string } | null = null;
    if (buildingId) {
      if (!(await this.repository.hasBuildingMembership(personId, buildingId))) {
        throw new AuthorizationError('You do not have access to this building.');
      }
      geography = await this.repository.findBuildingGeography(buildingId);
      if (!geography) throw new AuthorizationError('You do not have access to this building.');
    }

    const slot = await this.repository.findInterstitialSlot(
      INTERSTITIAL_SLOT_CODE[placement as keyof typeof INTERSTITIAL_SLOT_CODE],
    );
    if (
      !slot ||
      !slot.isActive ||
      slot.presentationFormat !== 'FULL_SCREEN' ||
      slot.placement !== placement ||
      slot.fillStrategy !== 'DIRECT_ONLY' ||
      slot.externalProvider !== 'NONE' ||
      slot.minimumDisplaySeconds == null ||
      slot.skippable == null ||
      slot.maxPerSession == null
    ) {
      return { placement, winner: null };
    }

    const candidates = await this.repository.findInterstitialCandidates({
      placement,
      now,
      buildingId,
      country: geography?.country,
      city: geography?.city,
    });
    const winner = candidates
      .filter((campaign) => campaign.adSlotId === slot.id && campaign.adSlot?.id === slot.id)
      .sort(
        (a, b) =>
          targetSpecificity(b) - targetSpecificity(a) ||
          b.priority - a.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )[0];
    if (!winner) return { placement, winner: null };

    return {
      placement,
      winner: {
        id: winner.id,
        source: winner.source,
        title: winner.title,
        description: winner.description,
        imageUrl: this.resolveCampaignImageUrl(winner.imageUrl),
        ctaLabel: winner.ctaLabel,
        ctaUrl: winner.ctaUrl,
        sponsored: true,
        slot: {
          id: slot.id,
          code: slot.code,
          placement: slot.placement,
          presentationFormat: slot.presentationFormat,
          minimumDisplaySeconds: slot.minimumDisplaySeconds,
          skippable: slot.skippable,
          maxPerSession: slot.maxPerSession,
        },
      },
    };
  }

  private assertValidSlotFill(input: UpdateAdSlotFillInput): void {
    if (input.fillStrategy === 'DIRECT_ONLY' && input.externalProvider !== 'NONE') {
      throw new ValidationError('DIRECT_ONLY slots must use provider NONE.');
    }
    if (input.fillStrategy !== 'DIRECT_ONLY' && input.externalProvider === 'NONE') {
      throw new ValidationError('External fill strategies require a provider.');
    }
    if (input.externalProvider !== 'ADMOB' && (input.androidAdUnitId || input.iosAdUnitId)) {
      throw new ValidationError('Ad unit IDs require the ADMOB provider.');
    }
    if (input.presentationFormat === 'FULL_SCREEN') {
      if (input.fillStrategy !== 'DIRECT_ONLY' || input.externalProvider !== 'NONE') {
        throw new ValidationError(
          'FULL_SCREEN slots must be direct-only with no external provider.',
        );
      }
      if (
        input.minimumDisplaySeconds == null ||
        input.minimumDisplaySeconds < 1 ||
        input.minimumDisplaySeconds > 10
      ) {
        throw new ValidationError('minimumDisplaySeconds must be between 1 and 10.');
      }
      if (input.skippable == null) {
        throw new ValidationError('FULL_SCREEN slots require a skippable policy.');
      }
      if (input.maxPerSession == null || input.maxPerSession < 1) {
        throw new ValidationError('maxPerSession must be at least 1.');
      }
    }
  }

  private resolveCampaignImageUrl(imageUrl: string): string {
    if (!imageUrl.startsWith('advertising/campaigns/') || !this.storage?.isConfigured()) {
      return imageUrl;
    }
    return this.storage.getPresignedDownloadUrl(imageUrl);
  }

  private async assertValidCampaignImage(imageUrl: string): Promise<void> {
    if (!imageUrl.startsWith('advertising/campaigns/')) return;
    if (!this.storage) throw new ValidationError('Campaign image storage is unavailable.');
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.readObjectPrefix(imageUrl, 16);
    } catch {
      throw new ValidationError('Campaign image could not be validated.');
    }
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
    const webp =
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!jpeg && !png && !webp) {
      throw new ValidationError('Campaign image content is not a valid JPEG, PNG, or WebP file.');
    }
  }

  private async assertValidCampaignImageOrCleanup(imageUrl: string): Promise<void> {
    try {
      await this.assertValidCampaignImage(imageUrl);
    } catch (error) {
      await this.cleanupInvalidCampaignImage(imageUrl);
      throw error;
    }
  }

  private async cleanupInvalidCampaignImage(imageUrl: string): Promise<void> {
    if (!imageUrl.startsWith('advertising/campaigns/') || !this.storage) return;
    try {
      await this.storage.deleteObject(imageUrl);
    } catch (error) {
      this.logger.warn(
        `Invalid advertising image cleanup failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  private async cleanupReplacedCampaignImage(imageUrl: string): Promise<void> {
    if (!imageUrl.startsWith('advertising/campaigns/') || !this.storage) return;
    try {
      await this.storage.deleteObject(imageUrl);
    } catch (error) {
      this.logger.warn(
        `Advertising image cleanup failed after campaign update: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  private normalizeAdUnitId(value?: string | null): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
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
    if (INTERSTITIAL_PLACEMENTS.includes(input.placement)) {
      if (slot.presentationFormat !== 'FULL_SCREEN') {
        throw new ValidationError('Interstitial campaigns require a FULL_SCREEN slot.');
      }
      if (input.source !== 'DIRECT') {
        throw new ValidationError('FULL_SCREEN slots accept DIRECT campaigns only.');
      }
    }
    if (slot.placement !== input.placement) {
      throw new ValidationError('Advertising slot is not compatible with campaign placement.');
    }
    const expectedZone = SLOT_ZONE_BY_PLACEMENT[input.placement];
    if (expectedZone && (slot.page !== 'HOME' || slot.zone !== expectedZone)) {
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
