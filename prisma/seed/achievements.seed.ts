import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ACHIEVEMENT_SEED_DATA } from '../../src/modules/gamification/domain/xp-catalog';

/** Reference data only. Upsert by code preserves existing row IDs. */
export async function seedAchievements(prisma: PrismaClient): Promise<void> {
  for (const achievement of ACHIEVEMENT_SEED_DATA) {
    await prisma.achievementDefinition.upsert({
      where: { code: achievement.code },
      update: achievement,
      create: achievement,
    });
  }
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedAchievements(prisma)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
