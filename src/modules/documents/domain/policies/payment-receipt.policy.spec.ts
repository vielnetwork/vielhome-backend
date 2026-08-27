import { PaymentReceiptPolicy } from './payment-receipt.policy';
import { ValidationError } from '../../../../common/errors/app-error';

describe('PaymentReceiptPolicy (FIN-REC-01B)', () => {
  let policy: PaymentReceiptPolicy;

  beforeEach(() => {
    policy = new PaymentReceiptPolicy();
  });

  describe('assertFileTypeSupported', () => {
    it.each(['PDF', 'JPG', 'JPEG', 'PNG', 'pdf', 'jpg'])(
      'allows supported type %s (case-insensitive)',
      (type) => {
        expect(() => policy.assertFileTypeSupported(type)).not.toThrow();
      },
    );

    it.each(['EXE', 'GIF', 'BMP', 'TXT', 'DOC', ''])(
      'rejects unsupported type %s with ValidationError',
      (type) => {
        expect(() => policy.assertFileTypeSupported(type)).toThrow(ValidationError);
      },
    );
  });

  describe('assertFileSizeWithinLimit', () => {
    const MAX = 25 * 1024 * 1024;

    it('allows a file exactly at the 25MB ceiling', () => {
      expect(() => policy.assertFileSizeWithinLimit(MAX)).not.toThrow();
    });

    it('allows a small file', () => {
      expect(() => policy.assertFileSizeWithinLimit(1)).not.toThrow();
    });

    it('rejects a file one byte over the ceiling', () => {
      expect(() => policy.assertFileSizeWithinLimit(MAX + 1)).toThrow(ValidationError);
    });

    it('rejects a wildly oversized file', () => {
      expect(() => policy.assertFileSizeWithinLimit(MAX * 10)).toThrow(ValidationError);
    });
  });
});
