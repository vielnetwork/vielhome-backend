import { Module } from '@nestjs/common';
import { SubscriptionFeatureResolverService } from './subscription-feature-resolver.service';
import { SubscriptionFeatureGuard } from '../guards/subscription-feature.guard';
import { SubscriptionPolicy } from '../../modules/backoffice/domain/policies/subscription.policy';

/**
 * Subscription Entitlement Enforcement (Monetization Phase 1). Standalone
 * on purpose: depends only on the global `PrismaModule` (`@Global()` —
 * see `common/prisma/prisma.module.ts`) plus a local instance of the
 * already-existing, dependency-free `SubscriptionPolicy` — never imports
 * `BackOfficeModule` itself, so any feature module (Finance today, others
 * later) can import this module to gate a route without pulling in the
 * entire Backoffice module graph or risking a circular import with it
 * (`BackOfficeModule` already imports `FinanceModule` for its own
 * Financial Administration sub-domain).
 */
@Module({
  providers: [SubscriptionPolicy, SubscriptionFeatureResolverService, SubscriptionFeatureGuard],
  exports: [SubscriptionFeatureResolverService, SubscriptionFeatureGuard],
})
export class SubscriptionFeatureModule {}
