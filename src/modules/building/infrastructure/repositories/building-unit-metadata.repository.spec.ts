import { BuildingRepository } from './building.repository';

describe('BuildingRepository paginated unit metadata', () => {
  it('uses bounded deterministic Prisma pagination and a separate count', async () => {
    const prisma = {
      unit: {
        findMany: jest.fn().mockResolvedValue([{ id: 'u-101', unitNumber: '101' }]),
        count: jest.fn().mockResolvedValue(205),
      },
    };
    const repository = new BuildingRepository(prisma as never);

    await expect(repository.listUnitMetadataPage('b1', { skip: 100, take: 100 })).resolves.toEqual({
      items: [{ id: 'u-101', unitNumber: '101' }],
      total: 205,
    });
    expect(prisma.unit.findMany).toHaveBeenCalledWith({
      where: { buildingId: 'b1' },
      orderBy: [{ unitNumber: 'asc' }, { id: 'asc' }],
      skip: 100,
      take: 100,
    });
    expect(prisma.unit.count).toHaveBeenCalledWith({
      where: { buildingId: 'b1' },
    });
  });
});
