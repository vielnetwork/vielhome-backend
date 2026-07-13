import { Injectable } from '@nestjs/common';
import type { SubscriptionFeatureKey, SubscriptionPlan } from '@prisma/client';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * 21_ADRs > ADR-059 — reclassified from `04.04_Subscription_Rules_v1.0`'s
 * Free/Pro matrix to `16_Monetization_v2.0`'s Free/Premium/Enterprise
 * lists. `23_v1_Handoff_Package_Reconciliation_v1.0`'s own "Resolved
 * Product Decisions" #1 (2026-07-09, BEFORE ADR-033 ever shipped) already
 * settled this exact question: "kept current Frozen model... the v1.0
 * package's Free/Pro model (locking Voting/Documents/Meetings/Funds/
 * Reports behind Pro) is not adopted." ADR-033 built `SubscriptionFeatureKey`
 * from the v1.0 package's matrix anyway, apparently without checking that
 * resolution — see ADR-059 for the full correction.
 *
 * `16_Monetization`'s Free Edition explicitly lists: Building Registration,
 * Owner/Tenant Management, Basic Finance, Basic Documents, Basic
 * Notifications, Community, Voting, Gamification, Basic Reports. Premium
 * lists (as improvements, never core-unlocks): Advanced Financial Reports,
 * Bulk Operations, Advanced Notifications, Advanced Analytics. Three keys
 * (`MEETINGS`, `REQUESTS`, `FUNDS`) aren't verbatim-named in either list —
 * `MEETINGS` follows `VOTING`'s explicit Free placement since Meetings is
 * the same Governance domain (ADR-049 built them side by side); `REQUESTS`
 * follows "Community" (04_Product_Architecture maps Requests/Complaints/
 * Suggestions onto Community, not Governance — see ADR-024 Decision point
 * 10); `FUNDS` follows "Basic Finance." These are disclosed interpretive
 * choices, not literal transcription — see ADR-059 Decision.
 */
const FREE_ACTIVE_FEATURES: SubscriptionFeatureKey[] = [
  'BUILDING_REGISTRATION',
  'PROPERTIES',
  'OWNERS',
  'TENANTS',
  'BASIC_CHARGES',
  'BASIC_PAYMENTS',
  'DEBT_VIEW',
  'IN_APP_NOTIFICATIONS',
  'ONLINE_PAYMENT',
  'DOCUMENTS',
  'VOTING',
  'MEETINGS',
  'REQUESTS',
  'FUNDS',
  'REPORTS',
];

/** Matches `16_Monetization`'s Premium examples: Advanced Financial Reports/Bulk Operations/Advanced Notifications/Advanced Analytics — improvements on top of a fully-usable Free Edition, never a lock on core functionality. */
const PRO_ONLY_FEATURES: SubscriptionFeatureKey[] = [
  'ADVANCED_ACCOUNTING',
  'SMS',
  'EMAIL',
  'PUSH_NOTIFICATIONS',
  'AUTOMATION',
];

export type FeatureAccessResult = 'ALLOWED' | 'DENIED';

export interface EffectiveFeatureEntry {
  featureKey: SubscriptionFeatureKey;
  result: FeatureAccessResult;
  source: 'PLAN' | 'GRANT';
}

/**
 * Pure business rules for Subscription Management
 * (07.04_Subscription_Management_v1.0 / 04.04_Subscription_Rules_v1.0 —
 * see 21_ADRs > ADR-033). No persistence access, fully unit-testable.
 */
@Injectable()
export class SubscriptionPolicy {
  /** 04.04 Rule 6/§Plans — which features a bare plan (no grants) includes. Free gets its own active list only; Pro/Enterprise get Free's list plus everything Free has locked. */
  planIncludesFeature(plan: SubscriptionPlan, featureKey: SubscriptionFeatureKey): boolean {
    if (FREE_ACTIVE_FEATURES.includes(featureKey)) return true;
    if (plan === 'FREE') return false;
    return PRO_ONLY_FEATURES.includes(featureKey);
  }

  /** 07.04 Rule 021/022 — Effective Features = Plan + active Feature Grants, resolved to a deterministic ALLOWED/DENIED per feature. */
  resolveEffectiveFeatures(
    plan: SubscriptionPlan,
    activeGrantFeatureKeys: SubscriptionFeatureKey[],
  ): EffectiveFeatureEntry[] {
    const allFeatures = [...FREE_ACTIVE_FEATURES, ...PRO_ONLY_FEATURES];
    return allFeatures.map((featureKey) => {
      if (activeGrantFeatureKeys.includes(featureKey)) {
        return { featureKey, result: 'ALLOWED' as const, source: 'GRANT' as const };
      }
      const allowed = this.planIncludesFeature(plan, featureKey);
      return {
        featureKey,
        result: (allowed ? 'ALLOWED' : 'DENIED') as FeatureAccessResult,
        source: 'PLAN' as const,
      };
    });
  }

  /** A Feature Grant is active when neither expired nor revoked. */
  isGrantActive(grant: { expiresAt: Date | null; revokedAt: Date | null }, now: Date): boolean {
    if (grant.revokedAt) return false;
    if (grant.expiresAt && grant.expiresAt <= now) return false;
    return true;
  }

  /** 07.04 Rule 013 — one trial per building; a building that has already used its trial cannot start another. */
  assertTrialAvailable(trialUsed: boolean): void {
    if (trialUsed) {
      throw new BusinessRuleViolationError('This building has already used its one-time trial.');
    }
  }

  /** A grant can only be revoked once. */
  assertGrantRevocable(revokedAt: Date | null): void {
    if (revokedAt) {
      throw new BusinessRuleViolationError('This feature grant has already been revoked.');
    }
  }

  /** 04.04 Rule 7 — 14 days, treated as canonical over 07.04's "14 or 30 day example" framing (see schema header comment). */
  defaultTrialDurationDays(): number {
    return 14;
  }
}
