import { Injectable } from '@nestjs/common';
import type {
  AdCampaign,
  AdCampaignSource,
  AdCampaignStatus,
  AdPlacement,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { PaginationParams } from '../../../../common/pagination/pagination.util';
import { buildPaginationMeta, toSkipTake } from '../../../../common/pagination/pagination.util';

export interface EligibleCampaignQuery {
  placement: AdPlacement;
  now: Date;
  buildingId: string;
  country: string;
  city: string;
  limit: number;
}

export interface AdminCampaignFilters {
  status?: AdCampaignStatus;
  source?: AdCampaignSource;
  placement?: AdPlacement;
  buildingId?: string;
}

/**
 * Monetization & Advertising — Phase 3/4. Thin Prisma wrapper for
 * `AdCampaign` — same "no business logic here, just queries" shape as
 * `PlatformStaffRepository`. Validation, lifecycle rules, and audit
 * recording all live in `AdCampaignService`.
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

  async listAdmin(filters: AdminCampaignFilters, pagination: PaginationParams) {
    const where: Prisma.AdCampaignWhereInput = {
      status: filters.status,
      source: filters.source,
      placement: filters.placement,
      buildingId: filters.buildingId,
    };
    const { skip, take } = toSkipTake(pagination);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.adCampaign.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.adCampaign.count({ where }),
    ]);
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  update(id: string, data: Prisma.AdCampaignUpdateInput): Promise<AdCampaign> {
    return this.prisma.adCampaign.update({ where: { id }, data });
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

  /** Phase 4 — the building's own country/city, reused as-is for
   * targeting matching (no parallel geography system). */
  findBuildingGeography(buildingId: string): Promise<{ country: string; city: string } | null> {
    return this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { country: true, city: true },
    });
  }

  /**
   * Phase 4 — Advertising Delivery API. Does the real eligibility
   * filtering in Prisma rather than loading every campaign for the
   * placement and filtering in memory: `status`/`placement`/schedule are
   * exact `WHERE` conditions, and each targeting dimension is an
   * "unrestricted OR matches" `OR` clause, all combined with `AND`
   * (composable, independent dimensions — a null dimension never narrows
   * the result). Ordered `priority DESC` then a fully deterministic
   * `createdAt ASC, id ASC` tie-breaker, capped at `limit`.
   */
  findEligibleForPlacement(query: EligibleCampaignQuery): Promise<AdCampaign[]> {
    return this.prisma.adCampaign.findMany({
      where: {
        placement: query.placement,
        status: 'ACTIVE',
        startsAt: { lte: query.now },
        endsAt: { gte: query.now },
        AND: [
          { OR: [{ targetCountry: null }, { targetCountry: query.country }] },
          { OR: [{ targetCity: null }, { targetCity: query.city }] },
          { OR: [{ buildingId: null }, { buildingId: query.buildingId }] },
        ],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
    });
  }
}
