import { BuildingSetupPolicy } from './building-setup.policy';
import { BusinessRuleViolationError, DuplicateError, ValidationError } from '../../../../common/errors/app-error';

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

  it('allows submit from review with all required fields present (province is NOT in the flat required list — see assertValidAddressHierarchy)', () => {
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

  // Building Setup Refinement Phase 2 — Country -> Province -> City +
  // Postal Code Normalization.
  describe('assertValidAddressHierarchy', () => {
    it('accepts a valid Iran country/province/city combination', () => {
      const result = policy.assertValidAddressHierarchy('IR', 'IR-TEHRAN', 'IR-TEHRAN-TEHRAN');
      expect(result).toEqual({ country: 'IR', province: 'IR-TEHRAN', city: 'IR-TEHRAN-TEHRAN' });
    });

    it('rejects an unsupported country code', () => {
      expect(() => policy.assertValidAddressHierarchy('US', undefined, 'Anywhere')).toThrow(
        ValidationError,
      );
    });

    it('rejects a display name used in place of a country code', () => {
      expect(() => policy.assertValidAddressHierarchy('Iran', undefined, 'Tehran')).toThrow(
        ValidationError,
      );
    });

    it('rejects Iran (IR) with a missing province', () => {
      expect(() =>
        policy.assertValidAddressHierarchy('IR', undefined, 'IR-TEHRAN-TEHRAN'),
      ).toThrow(ValidationError);
    });

    it('rejects Iran (IR) with a missing city', () => {
      expect(() => policy.assertValidAddressHierarchy('IR', 'IR-TEHRAN', undefined)).toThrow(
        ValidationError,
      );
    });

    it('rejects Iran (IR) with an unknown province code', () => {
      expect(() =>
        policy.assertValidAddressHierarchy('IR', 'IR-NOT-A-PROVINCE', 'IR-TEHRAN-TEHRAN'),
      ).toThrow(ValidationError);
    });

    it('rejects a city that belongs to a DIFFERENT Iranian province rather than silently repairing it', () => {
      expect(() =>
        policy.assertValidAddressHierarchy('IR', 'IR-TEHRAN', 'IR-RAZAVI_KHORASAN-MASHHAD'),
      ).toThrow(ValidationError);
    });

    // --- Correction round: non-IR countries have NO implemented
    // province/city dataset this phase. Mobile can no longer submit any
    // city for a non-IR country (Province and City selectors are both
    // disabled), and the backend must not silently accept or repair a
    // non-IR submission that carries address detail — it must reject it
    // with the project's normal 400 ValidationError. See
    // `assertValidAddressHierarchy`'s doc comment for the full rationale:
    // because `city` is unconditionally required by `assertCanSubmit`,
    // ANY non-IR submission that reaches this method necessarily carries
    // a city value that cannot be validated, so every non-IR submission
    // is rejected — Building Setup cannot complete end-to-end for a
    // non-IR country this phase, by design.

    it('rejects a non-Iran country that supplies a province — even a real Iranian one (the exact TR + IR-WEST_AZERBAIJAN scenario called out in the correction spec)', () => {
      expect(() =>
        policy.assertValidAddressHierarchy('TR', 'IR-WEST_AZERBAIJAN', 'some-city'),
      ).toThrow(ValidationError);
    });

    it('rejects a non-Iran country that supplies stale/tampered Iranian province AND city state together, rather than repairing or ignoring it', () => {
      expect(() =>
        policy.assertValidAddressHierarchy('TR', 'IR-TEHRAN', 'IR-TEHRAN-TEHRAN'),
      ).toThrow(ValidationError);
    });

    it('rejects a non-Iran country with an ordinary free-text city and no province — non-IR countries have no implemented dataset at all this phase, so free-text city is no longer accepted either', () => {
      expect(() => policy.assertValidAddressHierarchy('TR', undefined, 'Istanbul')).toThrow(
        ValidationError,
      );
    });

    it('rejects a non-Iran country with no province and no city submitted', () => {
      expect(() => policy.assertValidAddressHierarchy('TR', undefined, undefined)).toThrow(
        ValidationError,
      );
    });

    it('rejects a non-Iran country with a missing/blank city (still no province/city dataset exists for it)', () => {
      expect(() => policy.assertValidAddressHierarchy('TR', undefined, '')).toThrow(
        ValidationError,
      );
      expect(() => policy.assertValidAddressHierarchy('TR', undefined, '   ')).toThrow(
        ValidationError,
      );
    });

    it.each(['AZ', 'AM', 'TM', 'AF', 'PK', 'IQ', 'OM'])(
      'rejects %s (a supported country with no implemented dataset) the same way as TR',
      (country) => {
        expect(() => policy.assertValidAddressHierarchy(country, undefined, 'Some City')).toThrow(
          ValidationError,
        );
      },
    );
  });

  describe('normalizePostalCodeOrThrow', () => {
    it('normalizes and returns a valid Iranian postal code', () => {
      expect(policy.normalizePostalCodeOrThrow('IR', '1998877665')).toBe('1998877665');
    });

    it('normalizes Persian-digit Iranian postal codes', () => {
      expect(policy.normalizePostalCodeOrThrow('IR', '۱۹۹۸۸۷۷۶۶۵')).toBe('1998877665');
    });

    it('throws ValidationError for an Iranian postal code that is not exactly 10 digits', () => {
      expect(() => policy.normalizePostalCodeOrThrow('IR', '123')).toThrow(ValidationError);
    });

    it('throws ValidationError for a malformed Iranian postal code containing letters', () => {
      expect(() => policy.normalizePostalCodeOrThrow('IR', '199887766A')).toThrow(ValidationError);
    });

    it('applies the generic (lenient) rule for non-Iran countries', () => {
      expect(policy.normalizePostalCodeOrThrow('TR', 'AB123')).toBe('AB123');
    });

    it('still rejects an empty postal code for non-Iran countries', () => {
      expect(() => policy.normalizePostalCodeOrThrow('TR', '')).toThrow(ValidationError);
    });
  });
});
