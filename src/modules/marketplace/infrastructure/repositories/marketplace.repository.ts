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

  /** Public directory — approved + active only, matching `MarketplaceService`'s own visibility rule. */
  listApproved(filters: { category?: ServiceProviderCategory; city?: string }) {
    return this.prisma.serviceProvider.findMany({
      where: {
        status: 'APPROVED',
        isActive: true,
        category: filters.category,
        city: filters.city,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  listMine(submittedById: string) {
    return this.prisma.serviceProvider.findMany({
      where: { submittedById },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Staff moderation queue. */
  listForReview(filters: { status?: ServiceProviderStatus; category?: ServiceProviderCategory }) {
    return this.prisma.serviceProvider.findMany({
      where: { status: filters.status, category: filters.category },
      orderBy: { createdAt: 'asc' },
    });
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
