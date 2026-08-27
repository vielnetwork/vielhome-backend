import { ChargeKind, FundType } from '@prisma/client';
import {
  DeprecatedChargeKindError,
  IncompatibleChargeFundError,
} from '../../../../common/errors/app-error';
import { ChargeFundAlignmentPolicy, NEW_CHARGE_KIND_ORDER } from './charge-fund-alignment.policy';

describe('ChargeFundAlignmentPolicy', () => {
  const policy = new ChargeFundAlignmentPolicy();
  const mappings: Array<[ChargeKind, FundType]> = [
    [ChargeKind.MONTHLY, FundType.CURRENT],
    [ChargeKind.RESERVE, FundType.RESERVE],
    [ChargeKind.REPAIR, FundType.RENOVATION],
    [ChargeKind.EMERGENCY, FundType.EMERGENCY],
    [ChargeKind.INSURANCE, FundType.INSURANCE],
    [ChargeKind.OTHER, FundType.CUSTOM],
  ];

  it.each(mappings)('%s maps authoritatively to %s', (kind, fundType) => {
    expect(policy.compatibleFundTypes(kind)).toEqual([fundType]);
    expect(policy.isFundCompatible(kind, fundType)).toBe(true);
    expect(() => policy.assertFundCompatible(kind, fundType)).not.toThrow();
  });

  it('keeps deterministic new-kind ordering and never offers SPECIAL', () => {
    expect(NEW_CHARGE_KIND_ORDER).toEqual(mappings.map(([kind]) => kind));
    expect(policy.compatibleFundTypes(ChargeKind.SPECIAL)).toEqual([]);
  });

  it('rejects mismatched pairs with a stable error', () => {
    expect(() => policy.assertFundCompatible(ChargeKind.REPAIR, FundType.CURRENT)).toThrow(
      IncompatibleChargeFundError,
    );
  });

  it('rejects SPECIAL only for new creation while leaving the persisted enum intact', () => {
    expect(() => policy.assertSupportedForNewCreation(ChargeKind.SPECIAL)).toThrow(
      DeprecatedChargeKindError,
    );
    expect(ChargeKind.SPECIAL).toBe('SPECIAL');
  });
});
