import { SetMetadata } from '@nestjs/common';
import type { SubscriptionFeatureKey } from '@prisma/client';

export const REQUIRES_FEATURE_KEY = 'requiredSubscriptionFeature';

/**
 * Subscription Entitlement Enforcement (Monetization Phase 1) — marks a
 * route as requiring a specific `SubscriptionFeatureKey` to be part of the
 * calling building's effective feature set (plan match OR an active
 * `FeatureGrant` — see `SubscriptionFeatureResolverService`). Distinct
 * from `@RequiresAccess(AccessLevel)` (`access.decorator.ts`): that
 * vocabulary is person-level and its only implemented value today is
 * `BACKOFFICE_APPROVED` (`PRO` is a deliberate, unimplemented stub) — this
 * decorator is building-level and backed by the real, already-built
 * `Subscription`/`FeatureGrant` model (07.04/04.04 — see `ADR-033`).
 *
 * Pair with `@UseGuards(SubscriptionFeatureGuard)`, AFTER the route's
 * existing auth/role/permission guard(s) — this check is additional to,
 * never a replacement for, those. Only apply to routes shaped like
 * `/buildings/:id/...` (or any path with a `:buildingId` param) — the
 * guard resolves entitlement for the building in the URL.
 */
export const RequiresFeature = (feature: SubscriptionFeatureKey) =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);
