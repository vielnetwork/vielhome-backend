import {
  AdExternalProvider,
  AdPlacement,
  AdPresentationFormat,
  AdSlotFillStrategy,
} from '@prisma/client';
import { HOME_AD_SLOTS } from '../../../../prisma/seed/ad-slots.seed';

describe('interstitial slot foundation', () => {
  const byCode = (code: string) => HOME_AD_SLOTS.filter((slot) => slot.code === code);

  it('preserves the existing N/S slots as inline with their placement and fill semantics', () => {
    const inline = HOME_AD_SLOTS.filter((slot) => /^HOM-[NS]-/.test(slot.code));
    expect(inline).toHaveLength(9);
    expect(inline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'HOM-N-06',
          placement: AdPlacement.HOME_TODAY_OFFERS,
          presentationFormat: AdPresentationFormat.INLINE,
          fillStrategy: AdSlotFillStrategy.DIRECT_THEN_EXTERNAL,
          externalProvider: AdExternalProvider.ADMOB,
        }),
      ]),
    );
    expect(inline.every((slot) => slot.presentationFormat === AdPresentationFormat.INLINE)).toBe(
      true,
    );
  });

  it.each([
    ['HOM-I-01', AdPlacement.HOME_INTERSTITIAL],
    ['PAY-I-01', AdPlacement.PAYMENT_ENTRY_INTERSTITIAL],
  ] as const)('defines %s exactly once with the frozen full-screen policy', (code, placement) => {
    expect(byCode(code)).toHaveLength(1);
    expect(byCode(code)[0]).toEqual(
      expect.objectContaining({
        placement,
        presentationFormat: AdPresentationFormat.FULL_SCREEN,
        minimumDisplaySeconds: 3,
        skippable: true,
        maxPerSession: 1,
        fillStrategy: AdSlotFillStrategy.DIRECT_ONLY,
        externalProvider: AdExternalProvider.NONE,
        androidAdUnitId: null,
        iosAdUnitId: null,
      }),
    );
  });

  it('contains no duplicate slot codes, preserving idempotent upsert keys', () => {
    expect(new Set(HOME_AD_SLOTS.map((slot) => slot.code)).size).toBe(HOME_AD_SLOTS.length);
  });
});
