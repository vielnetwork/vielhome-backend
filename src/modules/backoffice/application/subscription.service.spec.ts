import { NotFoundAppError } from '../../../common/errors/app-error';
import { SubscriptionService } from './subscription.service';
import { SubscriptionPolicy } from '../domain/policies/subscription.policy';
import { SubscriptionFeatureResolverService } from '../../../common/subscription/subscription-feature-resolver.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import type { AuditService } from '../../../common/audit/audit.service';
import type {
  FeatureGrantType,
  SubscriptionFeatureKey,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';

const now = new Date('2026-08-10T10:00:00.000Z');
const later = new Date('2026-08-20T10:00:00.000Z');

interface SubscriptionFixture {
  id: string;
  buildingId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  trialUsed: boolean;
  gracePeriodDays: number;
  currentPeriodEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  featureGrants: Array<{
    id: string;
    subscriptionId: string;
    featureKey: SubscriptionFeatureKey;
    grantType: FeatureGrantType;
    reason: string | null;
    grantedById: string;
    grantedAt: Date;
    expiresAt: Date | null;
    revokedById: string | null;
    revokedAt: Date | null;
  }>;
}

function subscriptionFixture(): SubscriptionFixture {
  return {
    id: 'subscription-1',
    buildingId: 'building-1',
    plan: 'FREE' as const,
    status: 'TRIAL' as const,
    trialEndsAt: later,
    trialUsed: true,
    gracePeriodDays: 7,
    currentPeriodEndsAt: null,
    gracePeriodEndsAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    featureGrants: [
      {
        id: 'grant-1',
        subscriptionId: 'subscription-1',
        featureKey: 'SMS' as const,
        grantType: 'PROMOTION' as const,
        reason: null,
        grantedById: 'person-1',
        grantedAt: now,
        expiresAt: later,
        revokedById: null,
        revokedAt: null,
      },
    ],
  };
}

function makeService(subscription: SubscriptionFixture | null) {
  const backOffice = {
    findSubscriptionByBuildingId: jest.fn().mockResolvedValue(subscription),
    listSubscriptionHistory: jest.fn().mockResolvedValue([]),
  };
  const audit = { record: jest.fn() };
  return {
    service: new SubscriptionService(
      backOffice as unknown as BackOfficeRepository,
      new SubscriptionPolicy(),
      audit as unknown as AuditService,
    ),
    backOffice,
  };
}

describe('SubscriptionService read contract', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => jest.useRealTimers());

  it('returns the exact stable detail projection and preserves nullable dates', async () => {
    const source = subscriptionFixture();
    const { service } = makeService(source);

    await expect(service.getReadDetail('building-1')).resolves.toEqual(source);
    expect(Object.keys(await service.getReadDetail('building-1'))).toEqual([
      'id',
      'buildingId',
      'plan',
      'status',
      'trialEndsAt',
      'trialUsed',
      'gracePeriodDays',
      'currentPeriodEndsAt',
      'gracePeriodEndsAt',
      'cancelledAt',
      'createdAt',
      'updatedAt',
      'featureGrants',
    ]);
  });

  it.each(['FREE', 'PRO', 'ENTERPRISE'] as const)('preserves plan %s', async (plan) => {
    const source = { ...subscriptionFixture(), plan };
    const { service } = makeService(source);
    await expect(service.getReadDetail('building-1')).resolves.toMatchObject({ plan });
  });

  it.each(['TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED'] as const)(
    'preserves status %s',
    async (status) => {
      const source = { ...subscriptionFixture(), status };
      const { service } = makeService(source);
      await expect(service.getReadDetail('building-1')).resolves.toMatchObject({ status });
    },
  );

  it('returns 404 semantics for detail, features, and history when no row exists', async () => {
    const { service } = makeService(null);
    await expect(service.getReadDetail('missing')).rejects.toBeInstanceOf(NotFoundAppError);
    await expect(service.resolveEffectiveFeatures('missing')).rejects.toBeInstanceOf(
      NotFoundAppError,
    );
    await expect(service.getHistory('missing')).rejects.toBeInstanceOf(NotFoundAppError);
  });

  it('resolves a currently active grant as GRANT without consulting subscription status', async () => {
    const source = { ...subscriptionFixture(), status: 'CANCELLED' as const };
    const { service } = makeService(source);
    const result = await service.resolveEffectiveFeatures('building-1');
    expect(result.status).toBe('CANCELLED');
    expect(result.features.find((entry) => entry.featureKey === 'SMS')).toEqual({
      featureKey: 'SMS',
      result: 'ALLOWED',
      source: 'GRANT',
    });
  });

  it.each([
    { expiresAt: new Date('2000-01-01T00:00:00.000Z'), revokedAt: null },
    { expiresAt: null, revokedAt: now },
  ])('excludes inactive grants and falls back to PLAN: %o', async (grantState) => {
    const fixture = subscriptionFixture();
    fixture.featureGrants[0] = { ...fixture.featureGrants[0], ...grantState };
    const { service } = makeService(fixture);
    const result = await service.resolveEffectiveFeatures('building-1');
    expect(result.features.find((entry) => entry.featureKey === 'SMS')).toEqual({
      featureKey: 'SMS',
      result: 'DENIED',
      source: 'PLAN',
    });
  });

  it('returns repository history unchanged and scoped by subscription id', async () => {
    const { service, backOffice } = makeService(subscriptionFixture());
    const history = [
      {
        id: 'change-1',
        subscriptionId: 'subscription-1',
        fromPlan: null,
        toPlan: 'FREE',
        fromStatus: null,
        toStatus: 'TRIAL',
        changedById: null,
        reason: null,
        createdAt: now,
      },
    ];
    backOffice.listSubscriptionHistory.mockResolvedValue(history);

    await expect(service.getHistory('building-1')).resolves.toEqual(history);
    expect(backOffice.listSubscriptionHistory).toHaveBeenCalledWith('subscription-1');
  });

  it.each([
    {
      name: 'active paid plan',
      plan: 'PRO',
      status: 'ACTIVE',
      grant: 'none',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'PLAN',
    },
    {
      name: 'active grant overrides free plan',
      plan: 'FREE',
      status: 'ACTIVE',
      grant: 'active',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'GRANT',
    },
    {
      name: 'grant survives cancellation',
      plan: 'FREE',
      status: 'CANCELLED',
      grant: 'active',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'GRANT',
    },
    {
      name: 'cancelled free plan without grant',
      plan: 'FREE',
      status: 'CANCELLED',
      grant: 'none',
      feature: 'SMS',
      result: 'DENIED',
      source: 'PLAN',
    },
    {
      name: 'expired grant',
      plan: 'FREE',
      status: 'ACTIVE',
      grant: 'expired',
      feature: 'SMS',
      result: 'DENIED',
      source: 'PLAN',
    },
    {
      name: 'expiry boundary is exclusive',
      plan: 'FREE',
      status: 'CANCELLED',
      grant: 'boundary',
      feature: 'SMS',
      result: 'DENIED',
      source: 'PLAN',
    },
    {
      name: 'revoked grant',
      plan: 'FREE',
      status: 'ACTIVE',
      grant: 'revoked',
      feature: 'SMS',
      result: 'DENIED',
      source: 'PLAN',
    },
    {
      name: 'unrelated grant',
      plan: 'FREE',
      status: 'ACTIVE',
      grant: 'active',
      feature: 'EMAIL',
      result: 'DENIED',
      source: 'PLAN',
    },
    {
      name: 'free core access survives cancellation',
      plan: 'FREE',
      status: 'CANCELLED',
      grant: 'none',
      feature: 'DEBT_VIEW',
      result: 'ALLOWED',
      source: 'PLAN',
    },
    {
      name: 'revocation is not a plan deny',
      plan: 'PRO',
      status: 'ACTIVE',
      grant: 'revoked',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'PLAN',
    },
    {
      name: 'grant wins source when plan also allows',
      plan: 'PRO',
      status: 'ACTIVE',
      grant: 'active',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'GRANT',
    },
    {
      name: 'null expiry is an explicit permanent grant',
      plan: 'FREE',
      status: 'CANCELLED',
      grant: 'permanent',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'GRANT',
    },
    {
      name: 'status alone does not rewrite stored plan',
      plan: 'PRO',
      status: 'CANCELLED',
      grant: 'none',
      feature: 'SMS',
      result: 'ALLOWED',
      source: 'PLAN',
    },
  ] as const)('$name: read and runtime resolvers agree', async (scenario) => {
    const fixture = subscriptionFixture();
    fixture.plan = scenario.plan;
    fixture.status = scenario.status;
    if (scenario.grant === 'none') fixture.featureGrants = [];
    else {
      const grant = fixture.featureGrants[0];
      if (scenario.grant === 'expired') grant.expiresAt = new Date(now.getTime() - 1);
      if (scenario.grant === 'boundary') grant.expiresAt = now;
      if (scenario.grant === 'revoked') grant.revokedAt = now;
      if (scenario.grant === 'permanent') grant.expiresAt = null;
    }
    const { service } = makeService(fixture);
    const response = await service.resolveEffectiveFeatures('building-1');
    expect(response.features.find((entry) => entry.featureKey === scenario.feature)).toEqual({
      featureKey: scenario.feature,
      result: scenario.result,
      source: scenario.source,
    });
    const prisma = { subscription: { findUnique: jest.fn().mockResolvedValue(fixture) } };
    const runtime = new SubscriptionFeatureResolverService(
      prisma as unknown as PrismaService,
      new SubscriptionPolicy(),
    );
    await expect(runtime.isFeatureEnabled('building-1', scenario.feature)).resolves.toBe(
      scenario.result === 'ALLOWED',
    );
  });

  it('changes from GRANT to PLAN at the actual expiry instant', async () => {
    const { service } = makeService({ ...subscriptionFixture(), status: 'CANCELLED' });
    jest.setSystemTime(new Date(later.getTime() - 1));
    expect(
      (await service.resolveEffectiveFeatures('building-1')).features.find(
        (entry) => entry.featureKey === 'SMS',
      ),
    ).toMatchObject({ result: 'ALLOWED', source: 'GRANT' });
    jest.setSystemTime(later);
    expect(
      (await service.resolveEffectiveFeatures('building-1')).features.find(
        (entry) => entry.featureKey === 'SMS',
      ),
    ).toMatchObject({ result: 'DENIED', source: 'PLAN' });
  });
});
