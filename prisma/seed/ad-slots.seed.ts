import 'dotenv/config';
import {
  AdExternalProvider,
  AdPlacement,
  AdPresentationFormat,
  AdSlotFillStrategy,
  AdSlotOrientation,
  PrismaClient,
} from '@prisma/client';

const prisma = new PrismaClient();

export const HOME_AD_SLOTS = [
  ...Array.from({ length: 6 }, (_, index) => ({
    code: `HOM-N-0${index + 1}`,
    page: 'HOME',
    zone: 'N',
    position: index + 1,
    label: `Home — Top Carousel — Slot ${index + 1}`,
    description: `Position ${index + 1} in the Home top horizontal carousel.`,
    orientation: AdSlotOrientation.HORIZONTAL,
    placement: AdPlacement.HOME_TODAY_OFFERS,
    presentationFormat: AdPresentationFormat.INLINE,
    fillStrategy:
      index === 5 ? AdSlotFillStrategy.DIRECT_THEN_EXTERNAL : AdSlotFillStrategy.DIRECT_ONLY,
    externalProvider: index === 5 ? AdExternalProvider.ADMOB : AdExternalProvider.NONE,
    androidAdUnitId: index === 5 ? 'ca-app-pub-3940256099942544/2247696110' : null,
    iosAdUnitId: index === 5 ? 'ca-app-pub-3940256099942544/3986624511' : null,
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    code: `HOM-S-0${index + 1}`,
    page: 'HOME',
    zone: 'S',
    position: index + 1,
    label: `Home — Lower Ads — Slot ${index + 1}`,
    description: `Position ${index + 1} in the Home lower vertical advertising area.`,
    orientation: AdSlotOrientation.VERTICAL,
    placement: AdPlacement.HOME_FEATURED_LARGE,
    presentationFormat: AdPresentationFormat.INLINE,
    fillStrategy: AdSlotFillStrategy.DIRECT_ONLY,
    externalProvider: AdExternalProvider.NONE,
    androidAdUnitId: null,
    iosAdUnitId: null,
  })),
  {
    code: 'HOM-I-01',
    page: 'HOME',
    zone: 'I',
    position: 1,
    label: 'Home — Interstitial — Slot 1',
    description: 'Direct full-screen interstitial shown from Home.',
    orientation: AdSlotOrientation.VERTICAL,
    placement: AdPlacement.HOME_INTERSTITIAL,
    presentationFormat: AdPresentationFormat.FULL_SCREEN,
    minimumDisplaySeconds: 3,
    skippable: true,
    maxPerSession: 1,
    fillStrategy: AdSlotFillStrategy.DIRECT_ONLY,
    externalProvider: AdExternalProvider.NONE,
    androidAdUnitId: null,
    iosAdUnitId: null,
  },
  {
    code: 'PAY-I-01',
    page: 'PAYMENT',
    zone: 'I',
    position: 1,
    label: 'Payment Entry — Interstitial — Slot 1',
    description: 'Direct full-screen interstitial shown before payment entry.',
    orientation: AdSlotOrientation.VERTICAL,
    placement: AdPlacement.PAYMENT_ENTRY_INTERSTITIAL,
    presentationFormat: AdPresentationFormat.FULL_SCREEN,
    minimumDisplaySeconds: 3,
    skippable: true,
    maxPerSession: 1,
    fillStrategy: AdSlotFillStrategy.DIRECT_ONLY,
    externalProvider: AdExternalProvider.NONE,
    androidAdUnitId: null,
    iosAdUnitId: null,
  },
];

async function main() {
  for (const slot of HOME_AD_SLOTS) {
    await prisma.adSlot.upsert({
      where: { code: slot.code },
      update: { ...slot, isActive: true },
      create: slot,
    });
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
