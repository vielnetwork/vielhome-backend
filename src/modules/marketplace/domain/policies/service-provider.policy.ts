import { Injectable } from '@nestjs/common';
import type { ServiceProviderStatus } from '@prisma/client';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

/**
 * Marketplace Foundation (21_ADRs > ADR-030), extended by ADR-097
 * (Marketplace Review Workflow, Phase 2). Pure business-rule assertions,
 * no persistence access, matching every other domain policy's pattern.
 */
@Injectable()
export class ServiceProviderPolicy {
  /** A listing can only be reviewed once per submission — once APPROVED/
   * REJECTED, it's final until resubmitted (REJECTED -> PENDING via
   * `assertResubmittable`, then reviewable again). */
  assertReviewable(status: ServiceProviderStatus): void {
    if (status !== 'PENDING') {
      throw new BusinessRuleViolationError(`Listing is already reviewed (status: ${status}).`);
    }
  }

  /**
   * ADR-097 requirement 5. A REJECTED listing may be edited by its owner
   * before resubmitting. Currently coincides with `assertResubmittable`'s
   * own allowed set (both are REJECTED-only) because there is no DRAFT
   * status in this simplified lifecycle — kept as a separate, distinctly-
   * named assertion (rather than one shared method) since editing and
   * resubmitting are distinct actions that could reasonably diverge in a
   * future phase.
   */
  assertEditable(status: ServiceProviderStatus): void {
    if (status !== 'REJECTED') {
      throw new BusinessRuleViolationError(
        `Listing cannot be edited from its current status (status: ${status}).`,
      );
    }
  }

  /**
   * ADR-097 requirement 5. Only a REJECTED listing may be resubmitted —
   * PENDING/APPROVED/ARCHIVED are not valid sources (a fresh submission
   * for a new listing goes through the pre-existing, unchanged `POST
   * /marketplace/providers` instead, which creates directly at PENDING).
   */
  assertResubmittable(status: ServiceProviderStatus): void {
    if (status !== 'REJECTED') {
      throw new BusinessRuleViolationError(
        `Listing cannot be resubmitted from its current status (status: ${status}).`,
      );
    }
  }

  /** ADR-097 requirement 4. Only an APPROVED listing may be archived. */
  assertArchivable(status: ServiceProviderStatus): void {
    if (status !== 'APPROVED') {
      throw new BusinessRuleViolationError(
        `Only an APPROVED listing can be archived (status: ${status}).`,
      );
    }
  }

  /**
   * A non-approved (or deactivated) listing is visible only to its own
   * submitter — same "don't leak existence of someone else's pending/
   * rejected content" posture as `CasePolicy.assertVisible` for PRIVATE
   * cases, resolved as a 404 rather than a 403 by the caller (see
   * `MarketplaceService.getProvider`) so a guess at another person's
   * listing ID reveals nothing.
   *
   * ADR-097: this same rule now also covers ARCHIVED — reviewed and
   * confirmed the ADR's own visibility table ("Archived - backoffice
   * only") is read as "not part of the public directory," not as
   * "invisible to its own owner." An archived listing's owner keeps the
   * same visibility they had while it was PENDING/REJECTED: themselves
   * and staff, never the general public.
   */
  assertVisibleToNonStaff(submittedById: string, callerPersonId: string): void {
    if (submittedById !== callerPersonId) {
      throw new AuthorizationError('Not visible to this caller.');
    }
  }
}
