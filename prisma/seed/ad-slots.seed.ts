import 'dotenv/config';
import { AdSlotOrientation, PrismaClient } from '@prisma/client';

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
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    code: `HOM-S-0${index + 1}`,
    page: 'HOME',
    zone: 'S',
    position: index + 1,
    label: `Home — Lower Ads — Slot ${index + 1}`,
    description: `Position ${index + 1} in the Home lower vertical advertising area.`,
    orientation: AdSlotOrientation.VERTICAL,
  })),
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
