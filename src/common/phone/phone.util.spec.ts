import { isValidIranianMobilePhone, normalizeIranianMobilePhone } from './phone.util';

describe('phone.util', () => {
  describe('normalizeIranianMobilePhone — accepted forms', () => {
    it('normalizes 09XXXXXXXXX (leading trunk 0)', () => {
      expect(normalizeIranianMobilePhone('09121234567')).toBe('+989121234567');
    });

    it('normalizes 9XXXXXXXXX (bare, no leading 0)', () => {
      expect(normalizeIranianMobilePhone('9121234567')).toBe('+989121234567');
    });

    it('normalizes 989XXXXXXXXX (bare country code) WITHOUT double-prefixing', () => {
      // Regression: an earlier mobile PhoneFormatter bug turned this into
      // +98989XXXXXXXXX by unconditionally prepending +98 to any string
      // that didn't already start with +/0/00.
      const result = normalizeIranianMobilePhone('989121234567');
      expect(result).toBe('+989121234567');
      expect(result).not.toBe('+98989121234567');
    });

    it('leaves an already-canonical +989XXXXXXXXX value unchanged', () => {
      expect(normalizeIranianMobilePhone('+989121234567')).toBe('+989121234567');
    });
  });

  describe('normalizeIranianMobilePhone — digit conversion', () => {
    it('converts Persian digits', () => {
      expect(normalizeIranianMobilePhone('۰۹۱۲۱۲۳۴۵۶۷')).toBe('+989121234567');
    });

    it('converts Arabic-Indic digits', () => {
      expect(normalizeIranianMobilePhone('٠٩١٢١٢٣٤٥٦٧')).toBe('+989121234567');
    });

    it('converts a mix of Persian, Arabic-Indic, and ASCII digits in one value', () => {
      // 0(ascii) 9(ascii) ۱(persian 1) ٢(arabic-indic 2) 1(ascii) ۲(persian 2) 3(ascii) ٤(arabic-indic 4) 5(ascii) 6(ascii) 7(ascii)
      expect(normalizeIranianMobilePhone('09۱٢1۲3٤567')).toBe('+989121234567');
    });

    it('converts Persian digits combined with a +98 prefix', () => {
      expect(normalizeIranianMobilePhone('+98۹۱۲۱۲۳۴۵۶۷')).toBe('+989121234567');
    });
  });

  describe('normalizeIranianMobilePhone — allowed visual separators', () => {
    it('strips spaces', () => {
      expect(normalizeIranianMobilePhone('0912 123 4567')).toBe('+989121234567');
    });

    it('strips hyphens', () => {
      expect(normalizeIranianMobilePhone('0912-123-4567')).toBe('+989121234567');
    });

    it('trims leading/trailing whitespace', () => {
      expect(normalizeIranianMobilePhone('  09121234567  ')).toBe('+989121234567');
    });
  });

  describe('normalizeIranianMobilePhone — rejects rather than guesses', () => {
    it('rejects letters embedded in an otherwise valid-looking number', () => {
      // Must NOT silently strip "abc" and produce a valid-looking phone.
      expect(normalizeIranianMobilePhone('0912abc1234567')).toBeNull();
      expect(normalizeIranianMobilePhone('09121234567abc')).toBeNull();
    });

    it('rejects numbers that are too short', () => {
      expect(normalizeIranianMobilePhone('091212345')).toBeNull();
      expect(normalizeIranianMobilePhone('912123456')).toBeNull();
    });

    it('rejects numbers that are too long', () => {
      expect(normalizeIranianMobilePhone('091212345678')).toBeNull();
      expect(normalizeIranianMobilePhone('+9891212345678')).toBeNull();
    });

    it('rejects Iranian landline (non-mobile) numbers', () => {
      // Tehran (021) and Mashhad (051) landline shapes — no "09" mobile
      // trunk prefix, so these never match any accepted shape.
      expect(normalizeIranianMobilePhone('02112345678')).toBeNull();
      expect(normalizeIranianMobilePhone('05112345678')).toBeNull();
    });

    it('rejects the 0098 international prefix (explicitly out of scope for this task)', () => {
      expect(normalizeIranianMobilePhone('00989121234567')).toBeNull();
    });

    it('rejects empty string, whitespace-only, and non-string input', () => {
      expect(normalizeIranianMobilePhone('')).toBeNull();
      expect(normalizeIranianMobilePhone('   ')).toBeNull();
      expect(normalizeIranianMobilePhone(undefined)).toBeNull();
      expect(normalizeIranianMobilePhone(null)).toBeNull();
      expect(normalizeIranianMobilePhone(12345)).toBeNull();
    });

    it('rejects a non-Iranian E.164 number', () => {
      expect(normalizeIranianMobilePhone('+14155552671')).toBeNull();
    });

    it('rejects garbage input outright', () => {
      expect(normalizeIranianMobilePhone('not-a-phone')).toBeNull();
    });
  });

  describe('isValidIranianMobilePhone', () => {
    it('mirrors normalizeIranianMobilePhone as a boolean predicate', () => {
      expect(isValidIranianMobilePhone('09121234567')).toBe(true);
      expect(isValidIranianMobilePhone('0912abc1234567')).toBe(false);
    });
  });
});
