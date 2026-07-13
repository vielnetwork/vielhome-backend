import { Injectable } from '@nestjs/common';
import type { ServiceProviderStatus } from '@prisma/client';
import {
  AuthorizationError,
  BusinessRuleViolationError,
} from '../../../../common/errors/app-error';

/**
 * Marketplace Foundation (21_ADRs > ADR-030). Pure business-rule
 * assertions, no persistence access, matching every other domain policy's
 * pattern. Deliberately small — this domain has no concrete source spec,
 * so only the two rules actually needed by the moderation flow exist here;
 * nothing is invented beyond what the implementation requires.
 */
@Injectable()
export class ServiceProviderPolicy {
  /** A listing can only be reviewed once — once APPROVED/REJECTED, it's final for this MVP (no re-review/appeal flow, unlike Building/Manager Verification — no source doc describes one for Marketplace). */
  assertReviewable(status: ServiceProviderStatus): void {
    if (status !== 'PENDING') {
      throw new BusinessRuleViolationError(`Listing is already reviewed (status: ${status}).`);
    }
  }

  /**
   * A non-approved (or deactivated) listing is visible only to its own
   * submitter — same "don't leak existence of someone else's pending/
   * rejected content" posture as `CasePolicy.assertVisible` for PRIVATE
   * cases, resolved as a 404 rather than a 403 by the caller (see
   * `MarketplaceService.getProvider`) so a guess at another person's
   * listing ID reveals nothing.
   */
  assertVisibleToNonStaff(submittedById: string, callerPersonId: string): void {
    if (submittedById !== callerPersonId) {
      throw new AuthorizationError('Not visible to this caller.');
    }
  }
}
