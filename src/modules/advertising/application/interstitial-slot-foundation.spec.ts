import {
  AdExternalProvider,
  AdPlacement,
  AdPresentationFormat,
  AdSlotFillStrategy,
} from '@prisma/client';
import { HOME_AD_SLOTS } from '../../../../prisma/seed/ad-slots.seed';

describe('interstitial slot foundation', () => {
  const byCode = (code: string) => HOME_AD_SLOTS.filter((slot) => slot.code === code);

  it('keeps all N slots Direct-only and all S slots independently external-fallback eligible', () => {
    const inline = HOME_AD_SLOTS.filter((slot) => /^HOM-[NS]-/.test(slot.code));
    expect(inline).toHaveLength(9);
    expect(inline.every((slot) => slot.presentationFormat === AdPresentationFormat.INLINE)).toBe(
      true,
    );
    const native = inline.filter((slot) => slot.zone === 'N');
    expect(native).toHaveLength(6);
    expect(
      native.every(
        (slot) =>
          slot.placement === AdPlacement.HOME_TODAY_OFFERS &&
          slot.fillStrategy === AdSlotFillStrategy.DIRECT_ONLY &&
          slot.externalProvider === AdExternalProvider.NONE &&
          slot.androidAdUnitId === null &&
          slot.iosAdUnitId === null,
      ),
    ).toBe(true);

    const sponsored = inline.filter((slot) => slot.zone === 'S');
    expect(sponsored.map((slot) => slot.code)).toEqual(['HOM-S-01', 'HOM-S-02', 'HOM-S-03']);
    expect(
      sponsored.every(
        (slot) =>
          slot.placement === AdPlacement.HOME_FEATURED_LARGE &&
          slot.fillStrategy === AdSlotFillStrategy.DIRECT_THEN_EXTERNAL &&
          slot.externalProvider === AdExternalProvider.ADMOB &&
          slot.androidAdUnitId === null &&
          slot.iosAdUnitId === null,
      ),
    ).toBe(true);
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
