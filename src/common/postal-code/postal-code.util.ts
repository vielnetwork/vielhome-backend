/**
 * Centralized postal-code normalization — the postal-code counterpart of
 * `../phone/phone.util.ts`'s Iranian-mobile normalization, per the
 * Building Setup Refinement Phase 2 task (Country -> Province -> City +
 * Postal Code Normalization). Backend is authoritative: this is the real
 * correctness boundary, not just client-side UX (mobile's own
 * `PostalCodeFormatter` mirrors this logic for early feedback, but the
 * Building Setup submit boundary must still normalize+validate here
 * regardless of what the client already did).
 *
 * Shared first step for every country, mirroring `phone.util.ts`'s own
 * sequence:
 *   1. convert Persian (۰-۹) digits to ASCII
 *   2. convert Arabic-Indic (٠-٩) digits to ASCII
 *   3. trim
 *   4. remove ONLY explicitly allowed visual separators (spaces, hyphens)
 * Never guesses — anything that still doesn't match the target country's
 * shape after step 4 returns null, it is never coerced into a
 * plausible-looking postal code by stripping other characters.
 *
 * Iran (IR): exactly 10 ASCII digits after normalization. Letters, too
 * short, too long, or any other malformed shape all reject outright.
 *
 * Every other supported country (TR/AZ/AM/TM/AF/PK/IQ/OM): no official
 * per-country postal format is implemented yet — an explicit non-goal for
 * this phase (see the Building Setup Refinement audit's Section D/M6).
 * The generic rule below is deliberately lenient and temporary: 2-12
 * alphanumeric (ASCII, after digit normalization) characters, non-empty.
 * This is NOT a claim that each country's real postal standard has been
 * implemented — it exists only so the API rejects obvious garbage while a
 * real per-country rule is designed later, without inventing one now.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const persianIndex = PERSIAN_DIGITS.indexOf(ch);
    if (persianIndex !== -1) {
      out += String(persianIndex);
      continue;
    }
    const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arabicIndex !== -1) {
      out += String(arabicIndex);
      continue;
    }
    out += ch;
  }
  return out;
}

const IRAN_POSTAL_CODE_FORM = /^\d{10}$/;
const GENERIC_POSTAL_CODE_FORM = /^[A-Za-z0-9]{2,12}$/;

/** Country code this module currently has a strict, real format for. */
const IRAN_COUNTRY_CODE = 'IR';

/**
 * Normalizes `input` for `countryCode`, or returns null when it doesn't
 * match that country's accepted shape (Iran: exactly 10 digits; every
 * other supported country: the temporary generic 2-12 alphanumeric rule
 * above).
 */
export function normalizePostalCode(input: unknown, countryCode: string): string | null {
  if (typeof input !== 'string') return null;

  let value = toAsciiDigits(input).trim();
  value = value.replace(/[\s-]/g, '');
  if (value.length === 0) return null;

  if (countryCode === IRAN_COUNTRY_CODE) {
    return IRAN_POSTAL_CODE_FORM.test(value) ? value : null;
  }

  return GENERIC_POSTAL_CODE_FORM.test(value) ? value : null;
}

/** Convenience predicate over {@link normalizePostalCode}. */
export function isValidPostalCode(input: unknown, countryCode: string): boolean {
  return normalizePostalCode(input, countryCode) !== null;
}

/**
 * Digit-only normalization with NO length/shape validation — used by the
 * Address step's live duplicate-postal-code lookup (`GET
 * /buildings/lookup`), which runs while the person is still typing and
 * doesn't know the final country/shape yet. Only converts Persian/
 * Arabic-Indic digits to ASCII and strips the same visual separators, so
 * a partially-typed or non-Iranian postal code still matches its
 * canonical stored form instead of silently missing a real duplicate.
 */
export function normalizePostalCodeDigitsOnly(input: string): string {
  return toAsciiDigits(input).trim().replace(/[\s-]/g, '');
}
