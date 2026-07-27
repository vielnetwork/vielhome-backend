/**
 * Supported countries for Building Setup's address hierarchy (Building
 * Setup Refinement Phase 2 — Country -> Province -> City + Postal Code
 * Normalization). Stable ISO 3166-1 alpha-2 codes are the canonical
 * persisted identifier — never a translated display name (per the task's
 * explicit instruction). Adding a country later is a data-only change
 * here; it does NOT by itself grant that country a Province/City dataset
 * (see `iran-provinces.ts` / `iran-cities.ts` — Iran is the only country
 * with one this phase).
 */

export interface LocationNames {
  en: string;
  fa: string;
  tr: string;
}

export interface CountryOption {
  code: string;
  names: LocationNames;
}

export const SUPPORTED_COUNTRIES: readonly CountryOption[] = [
  { code: 'IR', names: { en: 'Iran', fa: 'ایران', tr: 'İran' } },
  { code: 'TR', names: { en: 'Türkiye', fa: 'ترکیه', tr: 'Türkiye' } },
  { code: 'AZ', names: { en: 'Azerbaijan', fa: 'آذربایجان', tr: 'Azerbaycan' } },
  { code: 'AM', names: { en: 'Armenia', fa: 'ارمنستان', tr: 'Ermenistan' } },
  { code: 'TM', names: { en: 'Turkmenistan', fa: 'ترکمنستان', tr: 'Türkmenistan' } },
  { code: 'AF', names: { en: 'Afghanistan', fa: 'افغانستان', tr: 'Afganistan' } },
  { code: 'PK', names: { en: 'Pakistan', fa: 'پاکستان', tr: 'Pakistan' } },
  { code: 'IQ', names: { en: 'Iraq', fa: 'عراق', tr: 'Irak' } },
  { code: 'OM', names: { en: 'Oman', fa: 'عمان', tr: 'Umman' } },
] as const;

const SUPPORTED_COUNTRY_CODES = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));

export function isSupportedCountryCode(code: unknown): code is string {
  return typeof code === 'string' && SUPPORTED_COUNTRY_CODES.has(code);
}

/** Only Iran has a Province/City dataset this phase (see module doc). */
export function countryHasAddressDataset(code: string): boolean {
  return code === 'IR';
}
