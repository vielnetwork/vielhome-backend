import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  DuplicateError,
  NotFoundAppError,
  ValidationError,
} from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';

export interface FeatureFlagFilters {
  enabled?: boolean;
  search?: string;
}

/**
 * 21_ADRs > ADR-109 — centralized, platform-wide operational
 * feature-toggle registry (see `FeatureFlag`'s own schema comment for how
 * this differs from the customer-facing `FeatureGrant` entitlement
 * model). No delete route in Phase 1 (see ADR-109 Non-Goals) — flags can
 * only be created and toggled.
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(filters: FeatureFlagFilters, pagination: PaginationParams) {
    const where = {
      enabled: filters.enabled,
      OR: filters.search
        ? [
            { key: { contains: filters.search, mode: 'insensitive' as const } },
            { label: { contains: filters.search, mode: 'insensitive' as const } },
          ]
        : undefined,
    };
    const { skip, take } = toSkipTake(pagination);
    const [items, total] = await Promise.all([
      this.prisma.featureFlag.findMany({ where, orderBy: { key: 'asc' }, skip, take }),
      this.prisma.featureFlag.count({ where }),
    ]);
    return { items, meta: buildPaginationMeta(pagination, total) };
  }

  async getByKey(key: string) {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) {
      throw new NotFoundAppError(`No feature flag found with key "${key}".`);
    }
    return flag;
  }

  async create(
    input: { key: string; label: string; description?: string; enabled?: boolean; reason: string },
    actorId: string,
    requestId: string,
  ) {
    const existing = await this.prisma.featureFlag.findUnique({ where: { key: input.key } });
    if (existing) {
      throw new DuplicateError(`A feature flag with key "${input.key}" already exists.`);
    }

    const flag = await this.prisma.featureFlag.create({
      data: {
        key: input.key,
        label: input.label,
        description: input.description,
        // Safe default: a newly-created flag starts disabled unless the
        // caller explicitly opts it in at creation time.
        enabled: input.enabled ?? false,
        updatedById: actorId,
      },
    });

    await this.audit.record({
      actorId,
      action: 'FeatureFlagCreated',
      entityType: 'FeatureFlag',
      entityId: flag.id,
      reason: input.reason,
      requestId,
      metadata: { key: flag.key, enabled: flag.enabled },
    });

    return flag;
  }

  /** At least one of `enabled`/`description` must be provided — a
   * reason-only PATCH with nothing actually changing is rejected rather
   * than silently accepted, since it would otherwise write a misleading
   * audit entry describing a change that didn't happen. */
  async update(
    key: string,
    input: { enabled?: boolean; description?: string; reason: string },
    actorId: string,
    requestId: string,
  ) {
    if (input.enabled === undefined && input.description === undefined) {
      throw new ValidationError('At least one of "enabled" or "description" must be provided.');
    }

    const existing = await this.getByKey(key);

    const flag = await this.prisma.featureFlag.update({
      where: { key },
      data: {
        enabled: input.enabled ?? existing.enabled,
        description: input.description ?? existing.description,
        updatedById: actorId,
      },
    });

    await this.audit.record({
      actorId,
      action: 'FeatureFlagUpdated',
      entityType: 'FeatureFlag',
      entityId: flag.id,
      reason: input.reason,
      requestId,
      metadata: {
        key: flag.key,
        before: { enabled: existing.enabled, description: existing.description },
        after: { enabled: flag.enabled, description: flag.description },
      },
    });

    return flag;
  }
}
