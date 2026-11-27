import { AuthorizationError, ConflictError, ValidationError } from '../../../common/errors/app-error';
import { TenancyPolicy } from '../domain/policies/tenancy.policy';
import { BuildingService } from './building.service';

describe('lease date changes', () => {
  function setup() {
    const lease = {
      id: 'lease',
      unitId: 'unit',
      unit: { buildingId: 'building' },
      isCurrent: true,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2027-01-01'),
      updatedAt: new Date('2026-01-01'),
    };
    const buildings = {
      findTenancyById: jest.fn().mockResolvedValue(lease),
      findById: jest.fn().mockResolvedValue({ id: 'building' }),
      findUnitById: jest.fn().mockResolvedValue({ id: 'unit', buildingId: 'building' }),
      isCurrentOwnerOfUnit: jest.fn().mockResolvedValue(true),
      getRoles: jest.fn().mockResolvedValue(['OWNER']),
      updateTenancyDates: jest.fn().mockResolvedValue(lease),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new BuildingService(
      buildings as never, null as never, null as never, null as never,
      new TenancyPolicy(), null as never, null as never, audit as never, null as never,
    );
    const update = (dates: { startDate?: string; endDate: string }) =>
      service.updateTenancyDates('building', 'lease', dates, 'person', 'request');
    return { buildings, lease, update };
  }

  it('renews the same lease and preserves its start date', async () => {
    const { buildings, lease, update } = setup();
    await update({ endDate: '2028-01-01' });
    expect(buildings.updateTenancyDates).toHaveBeenCalledWith({
      id: 'lease', updatedAt: lease.updatedAt, startDate: lease.startDate,
      endDate: new Date('2028-01-01'),
    });
  });

  it('allows correction to shorten the date range but rejects an invalid range', async () => {
    const { buildings, update } = setup();
    await update({ startDate: '2026-02-01', endDate: '2026-12-01' });
    await expect(update({ startDate: '2026-03-01', endDate: '2026-02-01' }))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(update({ endDate: '2026-12-01' })).rejects.toBeInstanceOf(ValidationError);
    expect(buildings.updateTenancyDates).toHaveBeenCalledTimes(1);
  });

  it('rejects tenant edits and changes after the lease ends', async () => {
    const { buildings, lease, update } = setup();
    buildings.isCurrentOwnerOfUnit.mockResolvedValueOnce(false);
    buildings.getRoles.mockResolvedValueOnce(['TENANT']);
    await expect(update({ endDate: '2028-01-01' })).rejects.toBeInstanceOf(AuthorizationError);
    lease.isCurrent = false;
    await expect(update({ endDate: '2028-01-01' })).rejects.toBeInstanceOf(ConflictError);
    expect(buildings.updateTenancyDates).not.toHaveBeenCalled();
  });
});
