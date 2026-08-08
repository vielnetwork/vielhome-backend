import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionFeatureGuard } from './subscription-feature.guard';
import { AuthorizationError } from '../errors/app-error';

function makeContext(params: Record<string, string>): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () => ({ params }),
    }),
  } as unknown as ExecutionContext;
}

describe('SubscriptionFeatureGuard', () => {
  it('denies when no @RequiresFeature() metadata is present on the route', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const resolver = { isFeatureEnabled: jest.fn() } as never;
    const guard = new SubscriptionFeatureGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ id: 'b1' }))).resolves.toBe(false);
    expect((resolver as { isFeatureEnabled: jest.Mock }).isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('denies when the route has no building id param at all', async () => {
    const reflector = { get: jest.fn().mockReturnValue('AUTOMATION') } as unknown as Reflector;
    const resolver = { isFeatureEnabled: jest.fn() } as never;
    const guard = new SubscriptionFeatureGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({}))).resolves.toBe(false);
    expect((resolver as { isFeatureEnabled: jest.Mock }).isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('allows when the resolver reports the building is entitled, via :id', async () => {
    const reflector = { get: jest.fn().mockReturnValue('AUTOMATION') } as unknown as Reflector;
    const resolver = { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never;
    const guard = new SubscriptionFeatureGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ id: 'b1' }))).resolves.toBe(true);
    expect((resolver as { isFeatureEnabled: jest.Mock }).isFeatureEnabled).toHaveBeenCalledWith(
      'b1',
      'AUTOMATION',
    );
  });

  it('falls back to :buildingId when :id is absent (Backoffice-shaped routes)', async () => {
    const reflector = { get: jest.fn().mockReturnValue('AUTOMATION') } as unknown as Reflector;
    const resolver = { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never;
    const guard = new SubscriptionFeatureGuard(reflector, resolver);

    await expect(guard.canActivate(makeContext({ buildingId: 'b2' }))).resolves.toBe(true);
    expect((resolver as { isFeatureEnabled: jest.Mock }).isFeatureEnabled).toHaveBeenCalledWith(
      'b2',
      'AUTOMATION',
    );
  });

  it('throws AuthorizationError (403) with details.requiredFeature when denied', async () => {
    const reflector = { get: jest.fn().mockReturnValue('AUTOMATION') } as unknown as Reflector;
    const resolver = { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as never;
    const guard = new SubscriptionFeatureGuard(reflector, resolver);

    let caught: unknown;
    try {
      await guard.canActivate(makeContext({ id: 'b1' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as AuthorizationError).httpStatus).toBe(403);
    expect((caught as AuthorizationError).details).toEqual({ requiredFeature: 'AUTOMATION' });
  });
});
