import { BuildingService } from './building.service';

describe('BuildingService GET /buildings active-context enrichment', () => {
  it('preserves every scope while retaining the legacy myRoles projection', async () => {
    const repository = {
      listForPerson: jest.fn().mockResolvedValue([{ id: 'building-a', name: 'Arya' }]),
      getMembershipScopesForBuildings: jest.fn().mockResolvedValue({
        'building-a': [
          {
            id: 'manager',
            buildingId: 'building-a',
            role: 'MANAGER',
            unitId: null,
            unit: null,
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
            id: 'tenant-3',
            buildingId: 'building-a',
            role: 'TENANT',
            unitId: 'unit-3',
            unit: { id: 'unit-3', unitNumber: '3' },
          },
          {
            id: 'owner-5',
            buildingId: 'building-a',
            role: 'OWNER',
            unitId: 'unit-5',
            unit: { id: 'unit-5', unitNumber: '5' },
          },
        ],
      }),
    };
    const service = new BuildingService(
      repository as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(service.listForPersonEnriched('person-me')).resolves.toEqual([
      {
        id: 'building-a',
        name: 'Arya',
        myRoles: ['MANAGER', 'BOARD_MEMBER', 'OWNER', 'TENANT', 'OWNER'],
        myMemberships: [
          { id: 'manager', role: 'MANAGER', unitId: null, unit: null },
          { id: 'board', role: 'BOARD_MEMBER', unitId: null, unit: null },
          {
            id: 'owner-1',
            role: 'OWNER',
            unitId: 'unit-1',
            unit: { id: 'unit-1', unitNumber: '1' },
          },
          {
            id: 'tenant-3',
            role: 'TENANT',
            unitId: 'unit-3',
            unit: { id: 'unit-3', unitNumber: '3' },
          },
          {
            id: 'owner-5',
            role: 'OWNER',
            unitId: 'unit-5',
            unit: { id: 'unit-5', unitNumber: '5' },
          },
        ],
      },
    ]);
    expect(repository.getMembershipScopesForBuildings).toHaveBeenCalledWith('person-me', [
      'building-a',
    ]);
  });

  it('keeps the zero-building response unchanged', async () => {
    const repository = {
      listForPerson: jest.fn().mockResolvedValue([]),
      getMembershipScopesForBuildings: jest.fn().mockResolvedValue({}),
    };
    const service = new BuildingService(
      repository as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(service.listForPersonEnriched('person-me')).resolves.toEqual([]);
  });
});
