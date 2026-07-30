import { Injectable } from '@nestjs/common';
import type { ServiceProviderCategory, ServiceProviderStatus } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * Marketplace Access-Gate Implementation Phase, requirement 6 — every
 * field is named explicitly (including `contactPhone`/`contactEmail`) so
 * a future added column to `ServiceProvider` can never leak into a
 * response through an implicit `SELECT *`-style bare Prisma call. This
 * does NOT redact anything by itself — it deliberately returns full rows
 * (contact fields included) to every caller; redaction for
 * unapproved/non-owner callers happens one layer up in
 * `MarketplaceService`, which is the only layer that knows who's asking.
 *
 * ADR-097 — Marketplace Review Workflow (Phase 2): adds `submittedAt`.
 */
const SERVICE_PROVIDER_SELECT = {
  id: true,
  name: true,
  category: true,
  description: true,
  contactPhone: true,
  contactEmail: true,
  city: true,
  status: true,
  isActive: true,
  submittedById: true,
  submittedAt: true,
  reviewedById: true,
  reviewedAt: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class MarketplaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  createProvider(params: {
    name: string;
    category: ServiceProviderCategory;
    description?: string;
    contactPhone?: string;
    contactEmail?: string;
    city?: string;
    submittedById: string;
  }) {
    return this.prisma.serviceProvider.create({ data: params });
  }

  findById(id: string) {
    return this.prisma.serviceProvider.findUnique({
      where: { id },
      select: SERVICE_PROVIDER_SELECT,
    });
  }

  /**
   * Public directory — approved + active only, matching `MarketplaceService`'s
   * own visibility rule. 21_ADRs > ADR-072 — paginated (08_API_Architecture
   * > Pagination); this is a platform-wide, unbounded listing by design
   * (`27_Performance_Review_v1.0` §1.3).
   */
  async listApproved(
    filters: { category?: ServiceProviderCategory; city?: string },
    pagination: { skip: number; take: number },
  ) {
    const where = {
      status: 'APPROVED' as const,
      isActive: true,
      category: filters.category,
      city: filters.city,
    };
    const [items, total] = await Promise.all([
      this.prisma.serviceProvider.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        select: SERVICE_PROVIDER_SELECT,
      }),
      this.prisma.serviceProvider.count({ where }),
    ]);
    return { items, total };
  }

  /** Own listings — always full visibility, no redaction anywhere in this
   * path (viewing your own submissions never hides your own contact
   * info). Includes every status, ARCHIVED included — "My Listings" is
   * the one screen ADR-097 explicitly wants every status visible on
   * (with a status badge), unlike the public directory or the
   * single-item `getProvider` route (which now also allows ARCHIVED for
   * the owner — see `MarketplaceService.getProvider`). */
  listMine(submittedById: string) {
    return this.prisma.serviceProvider.findMany({
      where: { submittedById },
      orderBy: { createdAt: 'desc' },
      select: SERVICE_PROVIDER_SELECT,
    });
  }

  /** Staff moderation queue. 21_ADRs > ADR-072 — paginated (08_API_Architecture > Pagination); structurally identical to the six BackOffice staff queues, so included here even though it wasn't one of `27_Performance_Review_v1.0`'s own named seven. */
  async listForReview(
    filters: { status?: ServiceProviderStatus; category?: ServiceProviderCategory },
    pagination: { skip: number; take: number },
  ) {
    const where = { status: filters.status, category: filters.category };
    const [items, total] = await Promise.all([
      this.prisma.serviceProvider.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.serviceProvider.count({ where }),
    ]);
    return { items, total };
  }

  decide(params: {
    id: string;
    status: ServiceProviderStatus;
    reviewedById: string;
    reason?: string;
  }) {
    return this.prisma.serviceProvider.update({
      where: { id: params.id },
      data: {
        status: params.status,
        reviewedById: params.reviewedById,
        reason: params.reason,
        reviewedAt: new Date(),
      },
    });
  }

  setActive(id: string, isActive: boolean) {
    return this.prisma.serviceProvider.update({ where: { id }, data: { isActive } });
  }

  /** ADR-097 requirement 5. Owner-only edit — only ever called while the
   * listing is REJECTED (`ServiceProviderPolicy.assertEditable`, enforced
   * one layer up). Partial update: only the fields the caller actually
   * sent are touched. Deliberately typed to exactly the mutable listing
   * fields — `status`/`submittedById`/`submittedAt`/`reviewedById`/
   * `reviewedAt`/`reason`/`isActive`/`createdAt`/`updatedAt` are not part
   * of this parameter type at all, so there is no code path through
   * which this method could touch them even if a caller tried. */
  updateListing(
    id: string,
    fields: Partial<{
      name: string;
      category: ServiceProviderCategory;
      description?: string;
      contactPhone?: string;
      contactEmail?: string;
      city?: string;
    }>,
  ) {
    return this.prisma.serviceProvider.update({ where: { id }, data: fields });
  }

  /** ADR-097 requirement 5. REJECTED -> PENDING (resubmit after edit) —
   * sets `submittedAt` to now, since this listing is re-entering the
   * review queue. Prior `reviewedById`/`reviewedAt`/`reason` from the
   * earlier rejection are deliberately left in place rather than cleared
   * — they stop being displayed anywhere the moment status is no longer
   * REJECTED, and preserving them keeps the review history intact for
   * staff (`getCase`) without inventing a separate history table. */
  resubmit(id: string) {
    return this.prisma.serviceProvider.update({
      where: { id },
      data: { status: 'PENDING', submittedAt: new Date() },
    });
  }

  /** ADR-097 requirement 4. APPROVED -> ARCHIVED. Coexists with (does not
   * replace) `setActive`/deactivate — archive is a distinct terminal
   * status, not a re-use of the `isActive` soft-deactivation flag. */
  archive(id: string) {
    return this.prisma.serviceProvider.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
  }
}
