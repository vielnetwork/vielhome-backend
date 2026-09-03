import { BuildingRepository } from './building.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

describe('BuildingRepository Finance authorization', () => {
  const count = jest.fn();
  const repository = new BuildingRepository({ membership: { count } } as unknown as PrismaService);

  beforeEach(() => count.mockReset());

  it('requires current privileged membership or exact-unit OWNER/TENANT membership', async () => {
    count.mockResolvedValue(1);

    await expect(repository.canReadUnitFinance('person-a', 'building-a', 'unit-a')).resolves.toBe(
      true,
    );
    expect(count).toHaveBeenCalledWith({
      where: {
        personId: 'person-a',
        buildingId: 'building-a',
        isCurrent: true,
        OR: [
          { role: { in: ['MANAGER', 'ACCOUNTANT'] } },
          {
            role: { in: ['OWNER', 'TENANT'] },
            unitId: 'unit-a',
            unit: { buildingId: 'building-a' },
          },
        ],
      },
    });
  });

  it('denies when no current exact-scope membership matches', async () => {
    count.mockResolvedValue(0);
    await expect(repository.canReadUnitFinance('person-a', 'building-a', 'unit-b')).resolves.toBe(
      false,
    );
  });
});
