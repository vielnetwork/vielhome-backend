import { LegalAcceptanceController } from './legal-acceptance.controller';
import { AuthorizationError, ConflictError } from '../../../common/errors/app-error';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

describe('legal acceptance', () => {
  const user = { sub: 'person-1' } as JwtPayload;
  function setup() {
    const prisma = {
      membership: { findFirst: jest.fn().mockResolvedValue(null) },
      legalAcceptance: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ acceptedAt: new Date() }),
      },
    };
    return { prisma, controller: new LegalAcceptanceController(prisma as never) };
  }

  it('stores the exact general terms and recognizes repeat visits', async () => {
    const { prisma, controller } = setup();
    const first = await controller.current(user);
    if (!('version' in first)) throw new Error('Missing general terms');
    expect(first.required).toBe(true);
    await controller.accept(user, undefined, first.scope, first.version);
    expect(prisma.legalAcceptance.upsert).toHaveBeenCalledWith({
      where: { personId_scope_version: { personId: user.sub, scope: first.scope, version: first.version } },
      update: {},
      create: expect.objectContaining({ title: first.title, text: first.text }),
      select: { acceptedAt: true },
    });
    prisma.legalAcceptance.findUnique.mockResolvedValue({ acceptedAt: new Date() });
    await expect(controller.current(user)).resolves.toMatchObject({ required: false });
  });

  it('prevents accepting an old assignment or acting as another building manager', async () => {
    const { prisma, controller } = setup();
    await expect(controller.accept(user, 'building-2', 'membership', 'v1'))
      .rejects.toBeInstanceOf(AuthorizationError);
    prisma.membership.findFirst.mockResolvedValue({
      id: 'new-term', startedAt: new Date(), building: { name: 'تهران ۱' },
    });
    const current = await controller.current(user, 'building-1');
    if (!('version' in current)) throw new Error('Missing manager terms');
    await expect(controller.accept(user, 'building-1', 'old-term', current.version))
      .rejects.toBeInstanceOf(ConflictError);
    expect(prisma.legalAcceptance.upsert).not.toHaveBeenCalled();
    await controller.accept(user, 'building-1', current.scope, current.version);
    expect(prisma.legalAcceptance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ scope: 'new-term', buildingId: 'building-1' }),
    }));
  });
});
