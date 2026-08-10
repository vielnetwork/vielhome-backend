import { NotFoundAppError } from '../../../common/errors/app-error';
import { SubscriptionService } from './subscription.service';
import { SubscriptionPolicy } from '../domain/policies/subscription.policy';
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
});
