import { Injectable, Logger } from '@nestjs/common';
import type { FeatureGrantType, SubscriptionFeatureKey, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { SubscriptionPolicy } from '../domain/policies/subscription.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * Subscription Management (07.04_Subscription_Management_v1.0 /
 * 04.04_Subscription_Rules_v1.0 — see 21_ADRs > ADR-033). Staff-facing
 * plan/status/feature-grant state management and effective-feature
 * resolution — deliberately NOT wired into any other domain's guards or
 * controllers this sprint (see the schema section's own header comment
 * and ADR-033 Decision for why).
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly backOffice: BackOfficeRepository,
    private readonly policy: SubscriptionPolicy,
    private readonly audit: AuditService,
  ) {}

  /** 04.04 Rule 7 — called by `BackOfficeEventListener` on every new building; auto-starts the one-time 14-day trial. */
  async initiateForNewBuilding(buildingId: string) {
    const trialEndsAt = new Date(Date.now() + this.policy.defaultTrialDurationDays() * 24 * 60 * 60 * 1000);
    const subscription = await this.backOffice.createSubscription({ buildingId, trialEndsAt });

    await this.backOffice.createSubscriptionChangeLog({
      subscriptionId: subscription.id,
      toPlan: 'FREE',
      toStatus: 'TRIAL',
      reason: 'Trial started automatically on building creation.',
    });

    return subscription;
  }

  async getForBuilding(buildingId: string) {
    const subscription = await this.backOffice.findSubscriptionByBuildingId(buildingId);
    if (!subscription) throw new NotFoundAppError('This building has no subscription record.');
    return subscription;
  }

  /** 07.04 Rule 011/014 — authorized staff may change a building's plan at any time (upgrade or downgrade); Rule 015 — downgrading never deletes data. */
  async changePlan(buildingId: string, newPlan: SubscriptionPlan, actorPersonId: string, reason: string | undefined, requestId: string) {
    const subscription = await this.getForBuilding(buildingId);

    const updated = await this.backOffice.updateSubscriptionPlan(subscription.id, newPlan);
    await this.backOffice.createSubscriptionChangeLog({
      subscriptionId: subscription.id,
      fromPlan: subscription.plan,
      toPlan: newPlan,
      changedById: actorPersonId,
      reason,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'SubscriptionPlanChanged',
      entityType: 'Subscription',
      entityId: subscription.id,
      requestId,
      reason,
      metadata: { fromPlan: subscription.plan, toPlan: newPlan },
    });

    return updated;
  }

  /**
   * 07.04 Rule 011 — authorized staff may set a subscription's status
   * directly (standing in for real billing-driven transitions, since no
   * payment gateway exists this sprint). `actorPersonId` is optional so
   * `evaluateExpiry` can call this for a time-based transition with no
   * staff actor, without inventing a fake Person row to satisfy the
   * `changedById`/`actorId` foreign keys.
   */
  async changeStatus(buildingId: string, newStatus: SubscriptionStatus, actorPersonId: string | undefined, reason: string | undefined, requestId: string) {
    const subscription = await this.getForBuilding(buildingId);

    const gracePeriodEndsAt =
      newStatus === 'EXPIRED' ? new Date(Date.now() + subscription.gracePeriodDays * 24 * 60 * 60 * 1000) : null;

    const updated = await this.backOffice.updateSubscriptionStatus({
      id: subscription.id,
      status: newStatus,
      cancelledAt: newStatus === 'CANCELLED' ? new Date() : undefined,
      gracePeriodEndsAt,
    });

    await this.backOffice.createSubscriptionChangeLog({
      subscriptionId: subscription.id,
      fromStatus: subscription.status,
      toStatus: newStatus,
      changedById: actorPersonId,
      reason,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'SubscriptionStatusChanged',
      entityType: 'Subscription',
      entityId: subscription.id,
      requestId,
      reason,
      metadata: { fromStatus: subscription.status, toStatus: newStatus },
    });

    return updated;
  }

  /**
   * Standing in for the not-yet-built scheduler (same recurring gap
   * ADR-024/025/026/028/029/031/032 have each already flagged): staff (or
   * a future BullMQ job calling this same method) manually triggers the
   * lifecycle's time-based transitions — 07.04's own Exception Cases
   * table:
   *   Trial Expired -> Downgrade To FREE (plan FREE, status ACTIVE — Free
   *     remains usable indefinitely, so it is not itself "expired").
   *   Active period lapsed -> EXPIRED, Grace Period starts (07.04 Rule
   *     007).
   *   Grace Period also lapsed -> final downgrade to FREE/ACTIVE (04.04
   *     Rule 12 — "the system does not become unusable"). Neither source
   *     document states this exact three-step sequencing explicitly — see
   *     ADR-033 Decision for the reasoned synthesis this method
   *     implements.
   */
  async evaluateExpiry(buildingId: string, actorPersonId: string | undefined, requestId: string) {
    const subscription = await this.getForBuilding(buildingId);
    const now = new Date();

    if (subscription.status === 'TRIAL' && subscription.trialEndsAt && subscription.trialEndsAt <= now) {
      await this.backOffice.updateSubscriptionPlan(subscription.id, 'FREE');
      const updated = await this.backOffice.updateSubscriptionStatus({ id: subscription.id, status: 'ACTIVE', gracePeriodEndsAt: null });
      await this.backOffice.createSubscriptionChangeLog({
        subscriptionId: subscription.id,
        fromPlan: subscription.plan,
        toPlan: 'FREE',
        fromStatus: 'TRIAL',
        toStatus: 'ACTIVE',
        changedById: actorPersonId,
        reason: 'Trial expired — downgraded to Free (07.04 Exception Case).',
      });
      await this.audit.record({
        actorId: actorPersonId,
        buildingId,
        action: 'SubscriptionTrialExpired',
        entityType: 'Subscription',
        entityId: subscription.id,
        requestId,
      });
      return updated;
    }

    if (subscription.status === 'ACTIVE' && subscription.currentPeriodEndsAt && subscription.currentPeriodEndsAt <= now) {
      return this.changeStatus(buildingId, 'EXPIRED', actorPersonId, 'Paid period ended — Grace Period started.', requestId);
    }

    if (subscription.status === 'EXPIRED' && subscription.gracePeriodEndsAt && subscription.gracePeriodEndsAt <= now) {
      await this.backOffice.updateSubscriptionPlan(subscription.id, 'FREE');
      const updated = await this.backOffice.updateSubscriptionStatus({ id: subscription.id, status: 'ACTIVE', gracePeriodEndsAt: null });
      await this.backOffice.createSubscriptionChangeLog({
        subscriptionId: subscription.id,
        fromPlan: subscription.plan,
        toPlan: 'FREE',
        fromStatus: 'EXPIRED',
        toStatus: 'ACTIVE',
        changedById: actorPersonId,
        reason: 'Grace Period ended — downgraded to Free (04.04 Rule 12).',
      });
      await this.audit.record({
        actorId: actorPersonId,
        buildingId,
        action: 'SubscriptionGracePeriodEnded',
        entityType: 'Subscription',
        entityId: subscription.id,
        requestId,
      });
      return updated;
    }

    return subscription;
  }

  /**
   * Scheduler entry point (21_ADRs > ADR-036) — runs `evaluateExpiry` for
   * every subscription with a pending time-based transition, with no
   * staff actor. The existing per-building manual endpoint (`POST
   * .../evaluate-expiry`) is unaffected and still lets staff force one
   * building's evaluation immediately.
   */
  async evaluateAllDueExpiries(requestId: string) {
    const due = await this.backOffice.findSubscriptionsDueForEvaluation();
    const results: Array<{ buildingId: string; ok: boolean; error?: string }> = [];
    for (const s of due) {
      try {
        await this.evaluateExpiry(s.buildingId, undefined, requestId);
        results.push({ buildingId: s.buildingId, ok: true });
      } catch (err) {
        this.logger.error(`Auto-evaluate-expiry failed for building=${s.buildingId}`, (err as Error)?.stack);
        results.push({ buildingId: s.buildingId, ok: false, error: (err as Error)?.message });
      }
    }
    return results;
  }

  /** 07.04 Rule 008/009/017 — grants a feature outside the plan, optionally time-boxed. */
  async createGrant(
    buildingId: string,
    params: { featureKey: SubscriptionFeatureKey; grantType: FeatureGrantType; reason?: string; expiresAt?: Date },
    actorPersonId: string,
    requestId: string,
  ) {
    const subscription = await this.getForBuilding(buildingId);

    const grant = await this.backOffice.createFeatureGrant({
      subscriptionId: subscription.id,
      featureKey: params.featureKey,
      grantType: params.grantType,
      reason: params.reason,
      grantedById: actorPersonId,
      expiresAt: params.expiresAt,
    });

    await this.audit.record({
      actorId: actorPersonId,
      buildingId,
      action: 'FeatureGrantCreated',
      entityType: 'FeatureGrant',
      entityId: grant.id,
      requestId,
      reason: params.reason,
      metadata: { featureKey: params.featureKey, grantType: params.grantType },
    });

    return grant;
  }

  /** 07.04 Rule 018 — every grant change (including revocation) must be recorded and traceable. */
  async revokeGrant(grantId: string, actorPersonId: string, requestId: string) {
    const grant = await this.backOffice.findFeatureGrantById(grantId);
    if (!grant) throw new NotFoundAppError('Feature grant not found.');
    this.policy.assertGrantRevocable(grant.revokedAt);

    const updated = await this.backOffice.revokeFeatureGrant(grantId, actorPersonId);

    await this.audit.record({
      actorId: actorPersonId,
      action: 'FeatureGrantRevoked',
      entityType: 'FeatureGrant',
      entityId: grantId,
      requestId,
    });

    return updated;
  }

  /** 07.04 Rule 021/022 — Effective Features = Plan + active Feature Grants, resolved deterministically. */
  async resolveEffectiveFeatures(buildingId: string) {
    const subscription = await this.getForBuilding(buildingId);
    const now = new Date();
    const activeGrantFeatureKeys = subscription.featureGrants
      .filter((grant) => this.policy.isGrantActive(grant, now))
      .map((grant) => grant.featureKey);

    return {
      plan: subscription.plan,
      status: subscription.status,
      features: this.policy.resolveEffectiveFeatures(subscription.plan, activeGrantFeatureKeys),
    };
  }

  /** 07.04 Rule 016 — subscription history (plans, trials, grants, expirations) must be preserved and queryable. */
  async getHistory(buildingId: string) {
    const subscription = await this.getForBuilding(buildingId);
    return this.backOffice.listSubscriptionHistory(subscription.id);
  }
}
