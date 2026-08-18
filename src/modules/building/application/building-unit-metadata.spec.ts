import { BuildingService } from './building.service';
import { UnitVisibilityPolicy } from '../domain/policies/unit-visibility.policy';

describe('BuildingService paginated unit metadata', () => {
  const units = [
    {
      id: 'u-101',
      buildingId: 'b1',
      unitNumber: '101',
      type: 'RESIDENTIAL',
      ownerPhone: null,
      parkingCount: 1,
      storageCount: 1,
    },
    {
      id: 'u-102',
      buildingId: 'b1',
      unitNumber: '102',
      type: 'COMMERCIAL',
      ownerPhone: null,
      parkingCount: 0,
      storageCount: 0,
    },
  ];

  function subject() {
    const buildings = {
      listUnitMetadataPage: jest.fn().mockResolvedValue({ items: units, total: 102 }),
      getRoles: jest.fn().mockResolvedValue(['OWNER', 'TENANT']),
      findCurrentOwnedUnitIdsForPerson: jest.fn().mockResolvedValue(new Set(['u-101'])),
      findCurrentTenantUnitIdsForPerson: jest.fn().mockResolvedValue(new Set(['u-102'])),
      findUnitIdsWithCurrentOwnership: jest.fn().mockResolvedValue(new Set(['u-101'])),
      findPersonById: jest.fn().mockResolvedValue({ id: 'p1', phone: '+989121234567' }),
      findCurrentOwnerSummariesForUnits: jest.fn().mockResolvedValue(
        new Map([
          ['u-101', { personId: 'p1', firstName: 'A', lastName: 'B', phone: '+989121234567' }],
          ['u-102', { personId: 'owner-2', firstName: 'C', lastName: 'D', phone: '+989121234568' }],
        ]),
      ),
      findCurrentTenantSummariesForUnits: jest.fn().mockResolvedValue(
        new Map([
          ['u-102', { personId: 'p1', firstName: 'A', lastName: 'B', phone: '+989121234567' }],
        ]),
      ),
    };
    const service = new BuildingService(
      buildings as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      new UnitVisibilityPolicy(),
      null as never,
      null as never,
    );
    return { service, buildings };
  }

  it('returns canonical pagination and preserves authoritative relationships', async () => {
    const { service, buildings } = subject();
    const result = await service.listUnitMetadataPage('b1', 'p1', {
      page: 2,
      limit: 100,
    });

    expect(buildings.listUnitMetadataPage).toHaveBeenCalledWith('b1', {
      skip: 100,
      take: 100,
    });
    expect(result.meta).toEqual({
      page: 2,
      limit: 100,
      total: 102,
      totalPages: 2,
    });
    expect(result.items[0]).toMatchObject({
      id: 'u-101',
      unitNumber: '101',
      type: 'RESIDENTIAL',
      parkingCount: 1,
      storageCount: 1,
      currentOwner: { personId: 'p1' },
      currentTenant: null,
    });
    expect(result.items[1]).toMatchObject({
      id: 'u-102',
      currentOwner: { personId: 'owner-2' },
      currentTenant: { personId: 'p1' },
    });
  });

  it('returns an empty canonical page', async () => {
    const { service, buildings } = subject();
    buildings.listUnitMetadataPage.mockResolvedValue({ items: [], total: 0 });
    const result = await service.listUnitMetadataPage('b1', 'p1', {
      page: 1,
      limit: 20,
    });
    expect(result.items).toEqual([]);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
    });
  });
});
