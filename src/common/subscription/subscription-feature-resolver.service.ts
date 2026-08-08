import { Injectable } from '@nestjs/common';
import type { SubscriptionFeatureKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionPolicy } from '../../modules/backoffice/domain/policies/subscription.policy';

/**
 * Subscription Entitlement Enforcement (Monetization Phase 1) — the
 * runtime counterpart to `SubscriptionService.resolveEffectiveFeatures`
 * (`src/modules/backoffice/application/subscription.service.ts`), which
 * exists, is tested, and is used by the Backoffice/member-facing read
 * routes, but — per the accepted `claude/monetization-advertising-
 * module-audit.md` — is never consulted by any product endpoint before
 * allowing an action.
 *
 * Deliberately reuses `SubscriptionPolicy`'s existing, already-unit-tested
 * pure rules (`planIncludesFeature`/`isGrantActive`) rather than
 * re-deriving the Free/Pro matrix here — a second copy of that matrix
 * would be a correctness risk (see `ADR-059`'s own account of how easily
 * this matrix drifted from the actual product decision once already).
 *
 * One query per check (`Subscription` + its `FeatureGrant`s, a single
 * `findUnique` with a nested include) — no N+1, and no per-feature
 * fan-out for a single-feature check the way `resolveEffectiveFeatures`
 * (which computes all ~20 keys) would produce. Deliberately NOT cached
 * yet — `isFeatureEnabled` is the one method a future cache-aside layer
 * would wrap (e.g. by `buildingId`, invalidated on `changePlan`/
 * `changeStatus`/grant create/revoke), so it's kept as a single, narrow
 * entry point rather than something callers reach past.
 *
 * Fails closed: a building with no `Subscription` row at all (should not
 * happen — one is auto-created on `BuildingCreatedEvent` — but not
 * guaranteed for every historical/test fixture) is treated as having no
 * entitlements, never as an unrestricted pass.
 */
@Injectable()
export class SubscriptionFeatureResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: SubscriptionPolicy,
  ) {}

  async isFeatureEnabled(
    buildingId: string,
    featureKey: SubscriptionFeatureKey,
  ): Promise<boolean> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { buildingId },
      include: { featureGrants: true },
    });
    if (!subscription) {
      return false;
    }

    const now = new Date();
    const hasActiveGrant = subscription.featureGrants.some(
      (grant) => grant.featureKey === featureKey && this.policy.isGrantActive(grant, now),
    );
    if (hasActiveGrant) {
      return true;
    }

    return this.policy.planIncludesFeature(subscription.plan, featureKey);
  }
}
