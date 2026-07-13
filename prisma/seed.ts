import { PrismaClient } from '@prisma/client';
// Relative import (not the `@modules/*` tsconfig path alias) — this file
// runs directly via `ts-node prisma/seed.ts` (see package.json's
// `db:seed` script), which doesn't resolve path aliases without an extra
// `tsconfig-paths/register` step nothing else in this repo needs yet.
import { ACHIEVEMENT_SEED_DATA } from '../src/modules/gamification/domain/xp-catalog';

const prisma = new PrismaClient();

/**
 * Minimal dev seed — one person you can OTP-login as immediately after
 * `docker-compose up -d && npx prisma migrate dev`. Expand as new domains
 * land. Gamification (ADR-028) added: `AchievementDefinition` rows must
 * exist before `GamificationService.awardXp` can unlock them — without
 * this seed step, XP still awards correctly but achievement unlocks
 * silently no-op (`GamificationRepository.unlockAchievement` returns null
 * for an unknown code, by design — see that method's doc comment).
 * BackOffice (ADR-029) added: `PlatformStaff` is seed-only this sprint
 * (no self-service admin UI) — without this seed step, every
 * `PlatformRolesGuard`-protected route 403s for everyone, with no way to
 * bootstrap the first admin.
 */
async function main() {
  const person = await prisma.person.upsert({
    where: { phone: '+989120000000' },
    update: {},
    create: {
      phone: '+989120000000',
      fullName: 'Dev Tester',
      locale: 'fa',
    },
  });

  console.log('Seeded person:', person);

  for (const achievement of ACHIEVEMENT_SEED_DATA) {
    await prisma.achievementDefinition.upsert({
      where: { code: achievement.code },
      update: { title: achievement.title, description: achievement.description, xpBonus: achievement.xpBonus },
      create: achievement,
    });
  }

  console.log(`Seeded ${ACHIEVEMENT_SEED_DATA.length} achievement definitions.`);

  // Dev Tester doubles as the first PLATFORM_ADMIN — a person can hold a
  // building Membership AND a PlatformStaff row at once, they're
  // deliberately separate identity concepts (see schema.prisma's
  // BackOffice section comment).
  await prisma.platformStaff.upsert({
    where: { personId: person.id },
    update: { role: 'PLATFORM_ADMIN', isActive: true },
    create: { personId: person.id, role: 'PLATFORM_ADMIN' },
  });

  const reviewer = await prisma.person.upsert({
    where: { phone: '+989120000001' },
    update: {},
    create: {
      phone: '+989120000001',
      fullName: 'BackOffice Reviewer',
      locale: 'fa',
    },
  });

  await prisma.platformStaff.upsert({
    where: { personId: reviewer.id },
    update: { role: 'REVIEWER', isActive: true },
    create: { personId: reviewer.id, role: 'REVIEWER' },
  });

  console.log('Seeded platform staff: Dev Tester (PLATFORM_ADMIN), BackOffice Reviewer (REVIEWER).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
