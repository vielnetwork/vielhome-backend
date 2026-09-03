import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuthorizationError } from '../../../common/errors/app-error';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/** Enforces the private Finance boundary for `/buildings/:id/units/:unitId/*`. */
@Injectable()
export class FinanceUnitReadGuard implements CanActivate {
  constructor(private readonly buildings: BuildingRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;
    const buildingId = request.params.id as string;
    const unitId = request.params.unitId as string;

    const allowed = await this.buildings.canReadUnitFinance(user.sub, buildingId, unitId);
    if (!allowed) {
      throw new AuthorizationError('You do not have access to this unit finance data.');
    }
    return true;
  }
}
