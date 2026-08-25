import { BuildingRepository } from './building.repository';

describe('BuildingRepository active-context membership scopes', () => {
  it('uses one filtered projection query and returns deterministic, uncollapsed scopes', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'owner-5',
        buildingId: 'building-a',
        role: 'OWNER',
        unitId: 'unit-5',
        unit: { id: 'unit-5', unitNumber: '5' },
      },
      {
        id: 'board',
        buildingId: 'building-a',
        role: 'BOARD_MEMBER',
        unitId: null,
        unit: null,
      },
      {
        id: 'owner-1',
        buildingId: 'building-a',
        role: 'OWNER',
        unitId: 'unit-1',
        unit: { id: 'unit-1', unitNumber: '1' },
      },
      {
        id: 'manager',
        buildingId: 'building-a',
        role: 'MANAGER',
        unitId: null,
        unit: null,
      },
    ]);
    const repository = new BuildingRepository({ membership: { findMany } } as never);

    const result = await repository.getMembershipScopesForBuildings('person-me', [
      'building-a',
      'building-empty',
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        personId: 'person-me',
        buildingId: { in: ['building-a', 'building-empty'] },
        isCurrent: true,
      },
      select: {
        id: true,
        buildingId: true,
        role: true,
        unitId: true,
        unit: { select: { id: true, unitNumber: true } },
      },
    });
    expect(result['building-a'].map((membership) => membership.id)).toEqual([
      'board',
      'manager',
      'owner-1',
      'owner-5',
    ]);
    expect(result['building-empty']).toEqual([]);
  });

  it('does not query when no accessible buildings exist', async () => {
    const findMany = jest.fn();
    const repository = new BuildingRepository({ membership: { findMany } } as never);

    await expect(repository.getMembershipScopesForBuildings('person-me', [])).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });
});
