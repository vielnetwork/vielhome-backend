import { isValidPostalCode, normalizePostalCode, normalizePostalCodeDigitsOnly } from './postal-code.util';

describe('postal-code.util', () => {
  describe('normalizePostalCode — Iran (IR)', () => {
    it('accepts an ASCII 10-digit postal code unchanged', () => {
      expect(normalizePostalCode('1234567890', 'IR')).toBe('1234567890');
    });

    it('converts Persian digits before validating', () => {
      expect(normalizePostalCode('۱۲۳۴۵۶۷۸۹۰', 'IR')).toBe('1234567890');
    });

    it('converts Arabic-Indic digits before validating', () => {
      expect(normalizePostalCode('١٢٣٤٥٦٧٨٩٠', 'IR')).toBe('1234567890');
    });

    it('converts a mix of Persian, Arabic-Indic, and ASCII digits', () => {
      // 1(ascii) ۲(persian 2) ٣(arabic 3) 4567890 (ascii)
      expect(normalizePostalCode('1۲٣4567890', 'IR')).toBe('1234567890');
    });

    it('strips spaces and hyphens as visual separators', () => {
      expect(normalizePostalCode('123 456-7890', 'IR')).toBe('1234567890');
    });

    it('rejects a value that is too short', () => {
      expect(normalizePostalCode('123456789', 'IR')).toBeNull();
    });

    it('rejects a value that is too long', () => {
      expect(normalizePostalCode('12345678901', 'IR')).toBeNull();
    });

    it('rejects letters embedded rather than guessing', () => {
      expect(normalizePostalCode('123456789A', 'IR')).toBeNull();
    });

    it('rejects an empty string', () => {
      expect(normalizePostalCode('', 'IR')).toBeNull();
    });

    it('rejects a whitespace-only string', () => {
      expect(normalizePostalCode('   ', 'IR')).toBeNull();
    });

    it('rejects a non-string input', () => {
      expect(normalizePostalCode(1234567890, 'IR')).toBeNull();
      expect(normalizePostalCode(null, 'IR')).toBeNull();
      expect(normalizePostalCode(undefined, 'IR')).toBeNull();
    });
  });

  describe('normalizePostalCode — generic (non-Iran) countries', () => {
    it('accepts a short alphanumeric code without imposing the 10-digit Iran rule', () => {
      expect(normalizePostalCode('AB123', 'TR')).toBe('AB123');
    });

    it('still converts Persian/Arabic-Indic digits for non-Iran countries', () => {
      expect(normalizePostalCode('۱۲۳۴۵', 'TR')).toBe('12345');
    });

    it('rejects an empty string', () => {
      expect(normalizePostalCode('', 'OM')).toBeNull();
    });

    it('rejects a single-character value (below the generic 2-char minimum)', () => {
      expect(normalizePostalCode('A', 'IQ')).toBeNull();
    });

    it('rejects a value longer than the generic 12-char maximum', () => {
      expect(normalizePostalCode('ABCDEFGHIJKLM', 'AF')).toBeNull();
    });

    it('strips hyphens as a visual separator, same as the phone-normalization precedent', () => {
      expect(normalizePostalCode('AB-12', 'PK')).toBe('AB12');
    });

    it('rejects characters outside the generic alphanumeric rule', () => {
      expect(normalizePostalCode('AB#12', 'PK')).toBeNull();
    });
  });

  describe('isValidPostalCode', () => {
    it('mirrors normalizePostalCode as a boolean predicate', () => {
      expect(isValidPostalCode('1234567890', 'IR')).toBe(true);
      expect(isValidPostalCode('123', 'IR')).toBe(false);
      expect(isValidPostalCode('AB123', 'TR')).toBe(true);
    });
  });

  describe('normalizePostalCodeDigitsOnly', () => {
    it('converts Persian/Arabic-Indic digits to ASCII with no shape validation', () => {
      expect(normalizePostalCodeDigitsOnly('۱۲۳')).toBe('123');
    });

    it('does not reject a short or malformed value — used for live lookups only', () => {
      expect(normalizePostalCodeDigitsOnly('AB')).toBe('AB');
      expect(normalizePostalCodeDigitsOnly('')).toBe('');
    });

    it('strips spaces and hyphens', () => {
      expect(normalizePostalCodeDigitsOnly('12 34-56')).toBe('123456');
    });
  });
});
