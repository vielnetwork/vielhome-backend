import type { ExecutionContext } from '@nestjs/common';
import { AuthorizationError } from '../../../common/errors/app-error';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { FinanceUnitReadGuard } from './finance-unit-read.guard';

describe('FinanceUnitReadGuard', () => {
  const canReadUnitFinance = jest.fn();
  const guard = new FinanceUnitReadGuard({ canReadUnitFinance } as unknown as BuildingRepository);

  const context = (personId = 'person-a', buildingId = 'building-a', unitId = 'unit-a') =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user: { sub: personId }, params: { id: buildingId, unitId } }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => canReadUnitFinance.mockReset());

  it('allows the exact unit authorized by the shared repository policy', async () => {
    canReadUnitFinance.mockResolvedValue(true);

    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(canReadUnitFinance).toHaveBeenCalledWith('person-a', 'building-a', 'unit-a');
  });

  it('denies another unit without revealing whether it exists', async () => {
    canReadUnitFinance.mockResolvedValue(false);

    await expect(guard.canActivate(context('person-a', 'building-a', 'unit-b'))).rejects.toThrow(
      AuthorizationError,
    );
  });
});
