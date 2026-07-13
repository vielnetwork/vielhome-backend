import { BuildingSetupPolicy } from './building-setup.policy';
import { BusinessRuleViolationError, DuplicateError } from '../../../../common/errors/app-error';

describe('BuildingSetupPolicy', () => {
  const policy = new BuildingSetupPolicy();

  it('rejects unknown wizard steps', () => {
    expect(() => policy.assertValidStep('not_a_step')).toThrow(BusinessRuleViolationError);
  });

  it('accepts known wizard steps', () => {
    expect(() => policy.assertValidStep('review')).not.toThrow();
  });

  it('only allows submit from the review step', () => {
    expect(() =>
      policy.assertCanSubmit('building_info', {
        role: 'OWNER',
        totalUnits: 10,
        country: 'IR',
        city: 'Tehran',
        district: 'Saadat Abad',
        mainStreet: 'Sarv',
        plateNumber: '12',
        postalCode: '1998877665',
      }),
    ).toThrow(BusinessRuleViolationError);
  });

  it('rejects submit when required fields are missing', () => {
    expect(() => policy.assertCanSubmit('review', { role: 'OWNER' })).toThrow(
      BusinessRuleViolationError,
    );
  });

  it('allows submit from review with all required fields present', () => {
    expect(() =>
      policy.assertCanSubmit('review', {
        role: 'OWNER',
        totalUnits: 10,
        country: 'IR',
        city: 'Tehran',
        district: 'Saadat Abad',
        mainStreet: 'Sarv',
        plateNumber: '12',
        postalCode: '1998877665',
      }),
    ).not.toThrow();
  });

  it('rejects duplicate unit numbers within the same building', () => {
    expect(() => policy.assertUniqueUnitNumber(['101', '102'], '101')).toThrow(
      BusinessRuleViolationError,
    );
  });

  it('rejects a postal code that already belongs to another building', () => {
    expect(() =>
      policy.assertPostalCodeAvailable({ id: 'b1', name: 'Existing', city: 'Tehran' }),
    ).toThrow(DuplicateError);
  });

  it('allows a postal code with no existing building', () => {
    expect(() => policy.assertPostalCodeAvailable(null)).not.toThrow();
  });
});
