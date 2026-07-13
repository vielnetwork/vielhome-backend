import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ServiceProviderCategory } from '@prisma/client';
import { MarketplaceRepository } from '../infrastructure/repositories/marketplace.repository';
import { ServiceProviderPolicy } from '../domain/policies/service-provider.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { SubmitServiceProviderDto } from './dto/submit-service-provider.dto';
import { ServiceProviderDecidedEvent } from '../events/marketplace.events';

/**
 * Marketplace Foundation (21_ADRs > ADR-030) — a moderated directory, not a
 * transactional marketplace. See the schema.prisma header comment above
 * `ServiceProvider` for the full reasoning on what's deliberately absent
 * (booking, payment, commission, escrow, ratings).
 */
@Injectable()
export class MarketplaceService {
  constructor(
    private readonly marketplace: MarketplaceRepository,
    private readonly policy: ServiceProviderPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async submit(callerPersonId: string, dto: SubmitServiceProviderDto, requestId: string) {
    const provider = await this.marketplace.createProvider({
      name: dto.name,
      category: dto.category,
      description: dto.description,
      contactPhone: dto.contactPhone,
      contactEmail: dto.contactEmail,
      city: dto.city,
      submittedById: callerPersonId,
    });

    await this.audit.record({
      actorId: callerPersonId,
      action: 'ServiceProviderSubmitted',
      entityType: 'ServiceProvider',
      entityId: provider.id,
      requestId,
      metadata: { category: dto.category },
    });

    return provider;
  }

  listApproved(filters: { category?: ServiceProviderCategory; city?: string }) {
    return this.marketplace.listApproved(filters);
  }

  listMine(callerPersonId: string) {
    return this.marketplace.listMine(callerPersonId);
  }

  /**
   * A non-approved/inactive listing is visible only to its own submitter —
   * resolved as `NotFoundAppError` for anyone else, per
   * `ServiceProviderPolicy.assertVisibleToNonStaff`'s doc comment.
   */
  async getProvider(id: string, callerPersonId: string) {
    const provider = await this.marketplace.findById(id);
    if (!provider) throw new NotFoundAppError('Service provider not found.');

    if (provider.status === 'APPROVED' && provider.isActive) return provider;

    this.policy.assertVisibleToNonStaff(provider.submittedById, callerPersonId);
    return provider;
  }

  // --- Staff moderation (PlatformRolesGuard-gated at the controller) -------

  async getCase(id: string) {
    const provider = await this.marketplace.findById(id);
    if (!provider) throw new NotFoundAppError('Service provider not found.');
    return provider;
  }

  listForReview(filters: { status?: string; category?: string }) {
    return this.marketplace.listForReview({
      status: filters.status as never,
      category: filters.category as never,
    });
  }

  async decide(
    id: string,
    decision: 'APPROVE' | 'REJECT',
    reviewerPersonId: string,
    reason: string | undefined,
    requestId: string,
  ) {
    const provider = await this.getCase(id);
    this.policy.assertReviewable(provider.status);

    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const updated = await this.marketplace.decide({
      id,
      status,
      reviewedById: reviewerPersonId,
      reason,
    });

    await this.audit.record({
      actorId: reviewerPersonId,
      action: 'ServiceProviderDecided',
      entityType: 'ServiceProvider',
      entityId: id,
      requestId,
      reason,
      metadata: { decision },
    });

    this.events.emit(
      'ServiceProviderDecided',
      new ServiceProviderDecidedEvent(id, status, provider.submittedById),
    );

    return updated;
  }

  /** Pulls a previously-approved listing without deleting its history — same "never hard delete" convention as every other domain. */
  async deactivate(id: string, actorPersonId: string, requestId: string) {
    await this.getCase(id); // existence check — throws NotFoundAppError if missing
    const updated = await this.marketplace.setActive(id, false);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'ServiceProviderDeactivated',
      entityType: 'ServiceProvider',
      entityId: id,
      requestId,
    });

    return updated;
  }
}
