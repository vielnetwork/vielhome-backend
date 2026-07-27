import { SUPPORTED_COUNTRIES, countryHasAddressDataset, isSupportedCountryCode } from './countries';
import { IRAN_PROVINCES, isValidIranProvinceCode } from './iran-provinces';
import {
  citiesForProvince,
  isValidIranCityCode,
  isValidIranCityForProvince,
} from './iran-cities';

describe('common/location', () => {
  describe('countries', () => {
    it('supports exactly the 9 frozen countries', () => {
      expect(SUPPORTED_COUNTRIES.map((c) => c.code).sort()).toEqual(
        ['AF', 'AM', 'AZ', 'IQ', 'IR', 'OM', 'PK', 'TM', 'TR'].sort(),
      );
    });

    it('every country has non-empty en/fa/tr display names', () => {
      for (const country of SUPPORTED_COUNTRIES) {
        expect(country.names.en.trim().length).toBeGreaterThan(0);
        expect(country.names.fa.trim().length).toBeGreaterThan(0);
        expect(country.names.tr.trim().length).toBeGreaterThan(0);
      }
    });

    it('isSupportedCountryCode accepts only the frozen list', () => {
      expect(isSupportedCountryCode('IR')).toBe(true);
      expect(isSupportedCountryCode('TR')).toBe(true);
      expect(isSupportedCountryCode('US')).toBe(false);
      expect(isSupportedCountryCode('Iran')).toBe(false);
      expect(isSupportedCountryCode(undefined)).toBe(false);
      expect(isSupportedCountryCode(123)).toBe(false);
    });

    it('only Iran has an address dataset this phase', () => {
      expect(countryHasAddressDataset('IR')).toBe(true);
      expect(countryHasAddressDataset('TR')).toBe(false);
      expect(countryHasAddressDataset('OM')).toBe(false);
    });
  });

  describe('iran-provinces', () => {
    it('includes all 31 provinces of Iran', () => {
      expect(IRAN_PROVINCES).toHaveLength(31);
    });

    it('every province code is unique', () => {
      const codes = IRAN_PROVINCES.map((p) => p.code);
      expect(new Set(codes).size).toBe(codes.length);
    });

    it('every province has non-empty en/fa/tr display names', () => {
      for (const province of IRAN_PROVINCES) {
        expect(province.names.en.trim().length).toBeGreaterThan(0);
        expect(province.names.fa.trim().length).toBeGreaterThan(0);
        expect(province.names.tr.trim().length).toBeGreaterThan(0);
      }
    });

    it('isValidIranProvinceCode accepts only real province codes', () => {
      expect(isValidIranProvinceCode('IR-TEHRAN')).toBe(true);
      expect(isValidIranProvinceCode('IR-NOT-A-PROVINCE')).toBe(false);
      expect(isValidIranProvinceCode(undefined)).toBe(false);
    });
  });

  describe('iran-cities', () => {
    it('covers more than just provincial capitals (well over 31 cities total)', () => {
      const total = IRAN_PROVINCES.reduce(
        (sum, p) => sum + citiesForProvince(p.code).length,
        0,
      );
      expect(total).toBeGreaterThan(100);
    });

    it('every province has at least one city', () => {
      for (const province of IRAN_PROVINCES) {
        expect(citiesForProvince(province.code).length).toBeGreaterThan(0);
      }
    });

    it('every city code is globally unique and scoped to its province (code prefix)', () => {
      const all = IRAN_PROVINCES.flatMap((p) => citiesForProvince(p.code));
      const codes = all.map((c) => c.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const city of all) {
        expect(city.code.startsWith(`${city.provinceCode}-`)).toBe(true);
      }
    });

    it('isValidIranCityForProvince accepts a real city in its real province', () => {
      expect(isValidIranCityForProvince('IR-TEHRAN-TEHRAN', 'IR-TEHRAN')).toBe(true);
    });

    it('isValidIranCityForProvince rejects a real city under the WRONG province — never silently repairs it', () => {
      // Mashhad is a real city, but belongs to Razavi Khorasan, not Tehran.
      expect(isValidIranCityForProvince('IR-RAZAVI_KHORASAN-MASHHAD', 'IR-TEHRAN')).toBe(false);
    });

    it('isValidIranCityForProvince rejects an unknown city code', () => {
      expect(isValidIranCityForProvince('IR-TEHRAN-NOT-A-CITY', 'IR-TEHRAN')).toBe(false);
    });

    it('isValidIranCityCode checks existence regardless of province', () => {
      expect(isValidIranCityCode('IR-TEHRAN-TEHRAN')).toBe(true);
      expect(isValidIranCityCode('IR-NOT-A-CITY')).toBe(false);
    });
  });
});
