/**
 * Centralized Iranian mobile phone normalization — the single place every
 * DTO in this API normalizes/validates a phone number, per the Phone
 * Number Input & Normalization task (21_ADRs). Backend is authoritative:
 * this is the real correctness boundary, not just client-side UX (mobile's
 * own `PhoneFormatter` mirrors this logic for early feedback, but every
 * account/membership-related phone DTO must still normalize+validate here
 * regardless of what the client already did).
 *
 * Frozen accepted input shapes (see the task's own scope freeze — do NOT
 * add 0098... or any other form without a fresh product decision):
 *   09XXXXXXXXX   (11 digits, leading trunk 0)
 *   9XXXXXXXXX    (10 digits, bare)
 *   989XXXXXXXXX  (12 digits, bare country code)
 *   +989XXXXXXXXX (13 chars, E.164 — already canonical, returned unchanged)
 * plus Persian (۰-۹) and Arabic-Indic (٠-٩) digit equivalents of any of
 * the above.
 *
 * Canonical output (and the only representation ever stored/searched):
 *   +989XXXXXXXXX
 *
 * Never guesses. The normalization sequence is deliberately narrow and
 * ordered:
 *   1. convert Persian digits to ASCII
 *   2. convert Arabic-Indic digits to ASCII
 *   3. trim
 *   4. remove ONLY explicitly allowed visual separators (spaces, hyphens)
 *   5. validate the exact shape against one of the four forms above
 *   6. normalize to +989XXXXXXXXX
 * Anything that still doesn't match one of the four shapes after step 4
 * (embedded letters, wrong length, a landline/non-mobile prefix, ...)
 * returns null — it is NEVER coerced into a plausible-looking phone
 * number by stripping arbitrary characters. E.g. "0912abc1234567" must
 * come back null, not get letters silently dropped into a valid shape.
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

// Each pattern is independently anchored/length-exact, so there is no
// prefix-stripping ambiguity between e.g. a bare 10-digit "989XXXXXXX"-
// shaped local number and the 12-digit "989" + 9-digit country-code form
// — only one of these four can ever match a given normalized string.
const PLUS_FORM = /^\+989\d{9}$/; // already canonical
const BARE_COUNTRY_FORM = /^989\d{9}$/; // 12 digits
const LOCAL_FORM = /^09\d{9}$/; // 11 digits
const SHORT_FORM = /^9\d{9}$/; // 10 digits

/**
 * Normalizes `input` to `+989XXXXXXXXX`, or returns null when it isn't
 * exactly one of the four accepted Iranian mobile shapes.
 */
export function normalizeIranianMobilePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  let value = toAsciiDigits(input).trim();
  value = value.replace(/[\s-]/g, '');

  if (PLUS_FORM.test(value)) return value;
  if (BARE_COUNTRY_FORM.test(value)) return `+${value}`;
  if (LOCAL_FORM.test(value)) return `+98${value.slice(1)}`;
  if (SHORT_FORM.test(value)) return `+98${value}`;

  return null;
}

/** Convenience predicate over {@link normalizeIranianMobilePhone}. */
export function isValidIranianMobilePhone(input: unknown): boolean {
  return normalizeIranianMobilePhone(input) !== null;
}
