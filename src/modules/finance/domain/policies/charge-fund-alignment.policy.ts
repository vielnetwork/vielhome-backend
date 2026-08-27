import { Injectable } from '@nestjs/common';
import { ChargeKind, FundType } from '@prisma/client';
import {
  DeprecatedChargeKindError,
  IncompatibleChargeFundError,
} from '../../../../common/errors/app-error';

export const NEW_CHARGE_KIND_ORDER = [
  ChargeKind.MONTHLY,
  ChargeKind.RESERVE,
  ChargeKind.REPAIR,
  ChargeKind.EMERGENCY,
  ChargeKind.INSURANCE,
  ChargeKind.OTHER,
] as const;

const FUND_TYPE_BY_CHARGE_KIND: Readonly<Record<(typeof NEW_CHARGE_KIND_ORDER)[number], FundType>> =
  {
    [ChargeKind.MONTHLY]: FundType.CURRENT,
    [ChargeKind.RESERVE]: FundType.RESERVE,
    [ChargeKind.REPAIR]: FundType.RENOVATION,
    [ChargeKind.EMERGENCY]: FundType.EMERGENCY,
    [ChargeKind.INSURANCE]: FundType.INSURANCE,
    [ChargeKind.OTHER]: FundType.CUSTOM,
  };

@Injectable()
export class ChargeFundAlignmentPolicy {
  compatibleFundTypes(chargeKind: ChargeKind): readonly FundType[] {
    if (chargeKind === ChargeKind.SPECIAL) return [];
    return [FUND_TYPE_BY_CHARGE_KIND[chargeKind]];
  }

  isFundCompatible(chargeKind: ChargeKind, fundType: FundType): boolean {
    return this.compatibleFundTypes(chargeKind).includes(fundType);
  }

  assertSupportedForNewCreation(chargeKind: ChargeKind): void {
    if (chargeKind === ChargeKind.SPECIAL) {
      throw new DeprecatedChargeKindError(
        'SPECIAL is a legacy charge type and cannot be used for new charges.',
      );
    }
  }

  assertFundCompatible(chargeKind: ChargeKind, fundType: FundType): void {
    this.assertSupportedForNewCreation(chargeKind);
    if (!this.isFundCompatible(chargeKind, fundType)) {
      throw new IncompatibleChargeFundError(
        'The selected fund is not compatible with this charge type.',
        { chargeKind, fundType },
      );
    }
  }
}
