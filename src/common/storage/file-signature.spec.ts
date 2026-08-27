import { detectFileSignature, normalizeDeclaredFileType } from './file-signature';

describe('file-signature (FIN-REC-01B magic-byte detection)', () => {
  describe('detectFileSignature', () => {
    it('detects a real PDF header ("%PDF-")', () => {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
      expect(detectFileSignature(bytes)).toBe('PDF');
    });

    it('detects a real PNG header', () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      expect(detectFileSignature(bytes)).toBe('PNG');
    });

    it('detects a real JPEG header (0xFFD8FF)', () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      expect(detectFileSignature(bytes)).toBe('JPEG');
    });

    it('returns null for plain text bytes matching no signature', () => {
      const bytes = new Uint8Array(Buffer.from('not a real file'));
      expect(detectFileSignature(bytes)).toBeNull();
    });

    it('returns null for an empty byte array', () => {
      expect(detectFileSignature(new Uint8Array(0))).toBeNull();
    });

    it('returns null for a byte array shorter than any signature', () => {
      expect(detectFileSignature(new Uint8Array([0x25, 0x50]))).toBeNull();
    });

    it('does not false-positive a PNG-length buffer of zeros as any type', () => {
      expect(detectFileSignature(new Uint8Array(8))).toBeNull();
    });
  });

  describe('normalizeDeclaredFileType', () => {
    it.each([
      ['PDF', 'PDF'],
      ['pdf', 'PDF'],
      ['PNG', 'PNG'],
      ['png', 'PNG'],
      ['JPG', 'JPEG'],
      ['jpg', 'JPEG'],
      ['JPEG', 'JPEG'],
      ['jpeg', 'JPEG'],
    ])('normalizes declared type %s to %s', (input, expected) => {
      expect(normalizeDeclaredFileType(input)).toBe(expected);
    });

    it('returns null for an unrecognized declared type', () => {
      expect(normalizeDeclaredFileType('EXE')).toBeNull();
      expect(normalizeDeclaredFileType('')).toBeNull();
    });
  });
});
