import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ServiceProviderCategory } from '@prisma/client';
import { MarketplaceRepository } from '../infrastructure/repositories/marketplace.repository';
import { ServiceProviderPolicy } from '../domain/policies/service-provider.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { BackOfficeRepository } from '../../backoffice/infrastructure/repositories/backoffice.repository';
import { AuthorizationError, NotFoundAppError } from '../../../common/errors/app-error';
import {
  buildPaginationMeta,
  toSkipTake,
  type PaginationParams,
} from '../../../common/pagination/pagination.util';
import { SubmitServiceProviderDto } from './dto/submit-service-provider.dto';
import { UpdateServiceProviderDto } from './dto/update-service-provider.dto';
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
  status: string;
  [key: string]: unknown;
}

/**
 * Marketplace Foundation (21_ADRs > ADR-030) — a moderated directory, not a
 * transactional marketplace. See the schema.prisma header comment above
 * `ServiceProvider` for the full reasoning on what's deliberately absent
 * (booking, payment, commission, escrow, ratings).
 *
 * ADR-097 — Marketplace Review Workflow (Phase 2) extends this with edit/
 * resubmit/approve/reject/archive, additive to the pre-existing direct-
 * submit path (`submit`, unchanged) rather than replacing it. Reviewed
 * and deliberately simplified from the ADR's own literal 5-state
 * DRAFT/PENDING_REVIEW/APPROVED/REJECTED/ARCHIVED proposal down to
 * PENDING/APPROVED/REJECTED/ARCHIVED — see `schema.prisma`'s own comment
 * on `ServiceProviderStatus` for why DRAFT was dropped and PENDING was
 * not renamed.
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

  /** `POST /marketplace/providers` — unchanged endpoint, unchanged wire
   * contract. Creates a listing already at PENDING in a single call; the
   * Marketplace Access Gate still applies at the controller. */
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

  /**
   * ADR-097 requirement 5. `PATCH /marketplace/providers/:id` —
   * owner-only, only while REJECTED (`ServiceProviderPolicy.
   * assertEditable`). A non-owner gets `AuthorizationError` (403); a
   * non-existent id gets `NotFoundAppError` (404) — same shape as
   * `getCase`'s own existence check.
   *
   * The set of fields this can touch is fixed at the call site below —
   * `name`/`category`/`description`/`contactPhone`/`contactEmail`/`city`
   * only. `status`/`submittedById`/`submittedAt`/`reviewedById`/
   * `reviewedAt`/`reason`/`isActive` are never read from `dto` here, so
   * there is no path through this method that could touch them —
   * defense in depth alongside `UpdateServiceProviderDto`'s own DTO
   * shape (which doesn't declare those properties at all) and the
   * application-wide `ValidationPipe({ whitelist: true,
   * forbidNonWhitelisted: true })`, which rejects any request body
   * containing an undeclared property before it ever reaches this
   * method.
   */
  async updateListing(
    id: string,
    callerPersonId: string,
    dto: UpdateServiceProviderDto,
    requestId: string,
  ) {
    const provider = await this.marketplace.findById(id);
    if (!provider) throw new NotFoundAppError('Service provider not found.');
    if (provider.submittedById !== callerPersonId) {
      throw new AuthorizationError('Only the listing owner may edit it.');
    }
    this.policy.assertEditable(provider.status);

    const updated = await this.marketplace.updateListing(id, {
      name: dto.name,
      category: dto.category,
      description: dto.description,
      contactPhone: dto.contactPhone,
      contactEmail: dto.contactEmail,
      city: dto.city,
    });

    await this.audit.record({
      actorId: callerPersonId,
      action: 'ServiceProviderEdited',
      entityType: 'ServiceProvider',
      entityId: id,
      requestId,
    });

    return updated;
  }

  /**
   * ADR-097 requirement 5. `POST /marketplace/providers/:id/resubmit` —
   * owner-only, REJECTED -> PENDING; gated by the Marketplace Access
   * Gate at the controller, same requirement as the legacy `submit`
   * endpoint.
   */
  async resubmit(id: string, callerPersonId: string, requestId: string) {
    const provider = await this.marketplace.findById(id);
    if (!provider) throw new NotFoundAppError('Service provider not found.');
    if (provider.submittedById !== callerPersonId) {
      throw new AuthorizationError('Only the listing owner may resubmit it.');
    }
    this.policy.assertResubmittable(provider.status);

    const updated = await this.marketplace.resubmit(id);

    await this.audit.record({
      actorId: callerPersonId,
      action: 'ServiceProviderResubmitted',
      entityType: 'ServiceProvider',
      entityId: id,
      requestId,
    });

    return updated;
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
   * A non-approved/inactive/archived listing is visible only to its own
   * submitter — resolved as `NotFoundAppError` for anyone else, per
   * `ServiceProviderPolicy.assertVisibleToNonStaff`'s doc comment. This
   * includes ARCHIVED: the owner keeps seeing their own archived
   * listing here (ADR-097's "backoffice only" visibility rule is read as
   * "not on the public directory," not as hidden from its own owner —
   * see the policy method's own doc comment); anyone who is neither the
   * owner nor staff still gets 404.
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

  /** ADR-097 requirement 4. `GET /backoffice/marketplace-providers/pending`
   * — a thin, named wrapper around the existing `listForReview`, filtered
   * to PENDING. The generic `GET /backoffice/marketplace-providers
   * ?status=...` route (unchanged) still works exactly as before; this
   * is purely an additive convenience matching the ADR's explicit
   * endpoint list. */
  listPending(pagination: PaginationParams) {
    return this.listForReview({ status: 'PENDING' }, pagination);
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

  /** ADR-097 requirement 4. `POST /backoffice/marketplace-providers/:id/
   * approve` — thin wrapper around the existing `decide`, reusing its
   * policy check, persistence, audit logging, and `ServiceProviderDecided`
   * event emission rather than duplicating any of them. The pre-existing
   * combined `/decide` route is left in place, unchanged. */
  approve(id: string, reviewerPersonId: string, requestId: string) {
    return this.decide(id, 'APPROVE', reviewerPersonId, undefined, requestId);
  }

  /** ADR-097 requirement 4. `POST /backoffice/marketplace-providers/:id/
   * reject` — thin wrapper around `decide`; `reason` is required at the
   * DTO layer (`RejectServiceProviderDto`), unlike the pre-existing
   * `/decide` route where it stays optional for backward compatibility. */
  reject(id: string, reviewerPersonId: string, reason: string, requestId: string) {
    return this.decide(id, 'REJECT', reviewerPersonId, reason, requestId);
  }

  /** ADR-097 requirement 4. `POST /backoffice/marketplace-providers/:id/
   * archive` — APPROVED -> ARCHIVED. Coexists with (does not replace) the
   * pre-existing `deactivate`, which toggles `isActive` without changing
   * `status`; archive is a distinct terminal status on the new lifecycle. */
  async archive(id: string, actorPersonId: string, requestId: string) {
    const provider = await this.getCase(id);
    this.policy.assertArchivable(provider.status);

    const updated = await this.marketplace.archive(id);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'ServiceProviderArchived',
      entityType: 'ServiceProvider',
      entityId: id,
      requestId,
    });

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
