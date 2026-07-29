import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ServiceProviderCategory } from '@prisma/client';
import { MarketplaceRepository } from '../infrastructure/repositories/marketplace.repository';
import { ServiceProviderPolicy } from '../domain/policies/service-provider.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { BackOfficeRepository } from '../../backoffice/infrastructure/repositories/backoffice.repository';
import { NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { SubmitServiceProviderDto } from './dto/submit-service-provider.dto';
import { ServiceProviderDecidedEvent } from '../events/marketplace.events';

/** Shape returned by `MarketplaceRepository`'s explicit-select queries
 * (`listApproved`/`findById`) — a plain structural type, not imported from
 * `@prisma/client`, so this file doesn't need to know the exact Prisma
 * payload-inference generic. */
interface ServiceProviderRecord {
  id: string;
  contactPhone: string | null;
  contactEmail: string | null;
  submittedById: string;
  [key: string]: unknown;
}

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
    private readonly backOffice: BackOfficeRepository,
  ) {}

  /**
   * Marketplace Access-Gate Implementation Phase, requirement 6. Contact
   * fields are visible to: (a) any BACKOFFICE_APPROVED caller, or (b) the
   * listing's own submitter viewing their own listing — an intentional
   * extension beyond the literal "unapproved -> hidden" rule, since an
   * unapproved person should still be able to see contact details they
   * themselves submitted (this is also what `listMine`, which never calls
   * this method, already assumes implicitly). Anyone else who is not
   * approved gets `contactVisible: false` and null contact fields — never
   * a masked/placeholder value (no existing API convention for that in
   * this codebase).
   */
  private redactContact<T extends ServiceProviderRecord>(
    provider: T,
    callerPersonId: string,
    callerIsApproved: boolean,
  ): T & { contactVisible: boolean } {
    const canSeeContact = callerIsApproved || provider.submittedById === callerPersonId;
    if (canSeeContact) {
      return {
        ...provider,
        contactVisible: provider.contactPhone != null || provider.contactEmail != null,
      };
    }
    return {
      ...provider,
      contactPhone: null,
      contactEmail: null,
      contactVisible: false,
    };
  }

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

  /** 21_ADRs > ADR-072. Redacts `contactPhone`/`contactEmail` per-item for
   * callers who are neither BACKOFFICE_APPROVED nor that item's own
   * submitter — see `redactContact`. Only one extra query regardless of
   * page size: the caller's own approval status is a single fact, not
   * per-item. */
  async listApproved(
    callerPersonId: string,
    filters: { category?: ServiceProviderCategory; city?: string },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.marketplace.listApproved(filters, toSkipTake(pagination));
    const callerIsApproved = await this.backOffice.isPersonBackofficeApproved(callerPersonId);
    const redacted = items.map((item) =>
      this.redactContact(item, callerPersonId, callerIsApproved),
    );
    return { items: redacted, meta: buildPaginationMeta(pagination, total) };
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

    if (provider.status !== 'APPROVED' || !provider.isActive) {
      this.policy.assertVisibleToNonStaff(provider.submittedById, callerPersonId);
    }

    const callerIsApproved = await this.backOffice.isPersonBackofficeApproved(callerPersonId);
    return this.redactContact(provider, callerPersonId, callerIsApproved);
  }

  // --- Staff moderation (PlatformRolesGuard-gated at the controller) -------

  async getCase(id: string) {
    const provider = await this.marketplace.findById(id);
    if (!provider) throw new NotFoundAppError('Service provider not found.');
    return provider;
  }

  /** 21_ADRs > ADR-072 */
  async listForReview(
    filters: { status?: string; category?: string },
    pagination: PaginationParams,
  ) {
    const { items, total } = await this.marketplace.listForReview(
      {
        status: filters.status as never,
        category: filters.category as never,
      },
      toSkipTake(pagination),
    );
    return { items, meta: buildPaginationMeta(pagination, total) };
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
