import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SubscriptionFeatureKey } from '@prisma/client';
import { AuthorizationError } from '../errors/app-error';
import { REQUIRES_FEATURE_KEY } from '../decorators/requires-feature.decorator';
import { SubscriptionFeatureResolverService } from '../subscription/subscription-feature-resolver.service';

/**
 * Subscription Entitlement Enforcement (Monetization Phase 1) — the
 * `SubscriptionFeatureKey` mirror of `RolesGuard`/`PermissionsGuard`/
 * `AccessGuard`: those check role/permission/person-level access; this
 * checks a building's resolved plan+grant entitlement against the
 * route's `@RequiresFeature(...)` requirement.
 *
 * No requirement decorated -> deny by default, the same convention every
 * sibling guard in this directory already uses (nothing to satisfy means
 * nothing is granted).
 *
 * Building-scoped, not person-scoped: reads `:id` (the convention every
 * `/buildings/:id/...` route in this codebase already uses — see
 * `RolesGuard`/`MembershipGuard`), falling back to `:buildingId` for a
 * route shaped like the Backoffice controllers instead. Since the lookup
 * is always scoped to whichever building id is in the URL (never a value
 * supplied by the caller elsewhere), a grant/plan on one building can
 * never unlock a route on another.
 *
 * Always apply AFTER the route's existing auth/role/permission guard —
 * this guard assumes the caller is already authorized to act on the
 * building at all; it only adds "...and does this building's plan
 * actually include this feature."
 */
@Injectable()
export class SubscriptionFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: SubscriptionFeatureResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.get<SubscriptionFeatureKey | undefined>(
      REQUIRES_FEATURE_KEY,
      context.getHandler(),
    );
    if (!requiredFeature) {
      return false;
    }

    const req = context.switchToHttp().getRequest();
    const buildingId = (req.params?.id ?? req.params?.buildingId) as string | undefined;
    if (!buildingId) {
      return false;
    }

    const allowed = await this.resolver.isFeatureEnabled(buildingId, requiredFeature);
    if (!allowed) {
      throw new AuthorizationError(
        `This action requires the "${requiredFeature}" feature, which is not included in this building's current plan.`,
        { requiredFeature },
      );
    }
    return true;
  }
}
