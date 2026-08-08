import { SubscriptionFeatureResolverService } from './subscription-feature-resolver.service';
import { SubscriptionPolicy } from '../../modules/backoffice/domain/policies/subscription.policy';

describe('SubscriptionFeatureResolverService', () => {
  const policy = new SubscriptionPolicy();

  function makePrisma(subscription: unknown) {
    return {
      subscription: { findUnique: jest.fn().mockResolvedValue(subscription) },
    } as unknown as ConstructorParameters<typeof SubscriptionFeatureResolverService>[0];
  }

  it('returns false when the building has no Subscription row (fail closed)', async () => {
    const service = new SubscriptionFeatureResolverService(makePrisma(null), policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(false);
  });

  it('returns true when the FREE plan already includes the requested feature', async () => {
    const prisma = makePrisma({ plan: 'FREE', featureGrants: [] });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'VOTING')).resolves.toBe(true);
  });

  it('returns false for a Pro-only feature on a FREE plan with no grant', async () => {
    const prisma = makePrisma({ plan: 'FREE', featureGrants: [] });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(false);
  });

  it('returns true for a Pro-only feature on a PRO plan', async () => {
    const prisma = makePrisma({ plan: 'PRO', featureGrants: [] });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(true);
  });

  it('returns true when an active FeatureGrant overrides a FREE plan (grant wins)', async () => {
    const prisma = makePrisma({
      plan: 'FREE',
      featureGrants: [{ featureKey: 'AUTOMATION', expiresAt: null, revokedAt: null }],
    });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(true);
  });

  it('ignores an expired FeatureGrant and falls back to the plan (denied)', async () => {
    const prisma = makePrisma({
      plan: 'FREE',
      featureGrants: [
        { featureKey: 'AUTOMATION', expiresAt: new Date(Date.now() - 1000), revokedAt: null },
      ],
    });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(false);
  });

  it('ignores a revoked FeatureGrant and falls back to the plan (denied)', async () => {
    const prisma = makePrisma({
      plan: 'FREE',
      featureGrants: [{ featureKey: 'AUTOMATION', expiresAt: null, revokedAt: new Date() }],
    });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(false);
  });

  it('ignores a grant for a different feature key', async () => {
    const prisma = makePrisma({
      plan: 'FREE',
      featureGrants: [{ featureKey: 'SMS', expiresAt: null, revokedAt: null }],
    });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await expect(service.isFeatureEnabled('b1', 'AUTOMATION')).resolves.toBe(false);
  });

  it('queries exactly once, scoped to the given buildingId only', async () => {
    const prisma = makePrisma({ plan: 'FREE', featureGrants: [] });
    const service = new SubscriptionFeatureResolverService(prisma, policy);
    await service.isFeatureEnabled('building-A', 'AUTOMATION');

    const findUnique = (
      prisma as unknown as {
        subscription: { findUnique: jest.Mock };
      }
    ).subscription.findUnique;
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { buildingId: 'building-A' },
      include: { featureGrants: true },
    });
  });
});
