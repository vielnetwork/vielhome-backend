import { Injectable } from '@nestjs/common';
import type { ServiceProviderCategory, ServiceProviderStatus } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

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
    return this.prisma.serviceProvider.findUnique({ where: { id } });
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
      }),
      this.prisma.serviceProvider.count({ where }),
    ]);
    return { items, total };
  }

  listMine(submittedById: string) {
    return this.prisma.serviceProvider.findMany({
      where: { submittedById },
      orderBy: { createdAt: 'desc' },
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
}
