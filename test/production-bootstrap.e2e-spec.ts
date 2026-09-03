import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PermissionKey, PrismaClient } from '@prisma/client';
import { ACHIEVEMENT_SEED_DATA } from '../src/modules/gamification/domain/xp-catalog';
import { HOME_AD_SLOTS } from '../prisma/seed/ad-slots.seed';

// Opt-in only: this suite needs a freshly migrated, disposable database.
// It must never run against the shared application database by accident.
const enabled = process.env.PROD_SEED_TEST_DATABASE_URL !== undefined;
(enabled ? describe : describe.skip)('Production reference bootstrap (PROD-SEED-01)', () => {
  let prisma: PrismaClient;
  let beforeRerun: unknown;
  const run = (file: string) =>
    execFileSync(process.execPath, ['-r', 'ts-node/register', join(process.cwd(), file)], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: process.env.PROD_SEED_TEST_DATABASE_URL,
      },
      stdio: 'pipe',
    });
  const snapshot = async () => ({
    permissions: await prisma.permission.findMany({ orderBy: { id: 'asc' } }),
    roles: await prisma.role.findMany({ orderBy: { id: 'asc' } }),
    grants: await prisma.rolePermission.findMany({ orderBy: { id: 'asc' } }),
    achievements: await prisma.achievementDefinition.findMany({ orderBy: { code: 'asc' } }),
    slots: (await prisma.adSlot.findMany({ orderBy: { code: 'asc' } })).map(
      ({ updatedAt: _updatedAt, ...slot }) => slot,
    ),
    audits: await prisma.auditLog.count(),
  });

  beforeAll(async () => {
    const url = new URL(process.env.PROD_SEED_TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.pathname.includes('prod_seed_test')
    ) {
      throw new Error('Use a disposable local prod_seed_test database only.');
    }
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    expect(await prisma.person.count()).toBe(0);
    expect(await prisma.platformStaff.count()).toBe(0);
    run('prisma/seed.ts');
    beforeRerun = await snapshot();
  }, 120_000);

  afterAll(async () => prisma?.$disconnect());

  it('populates every authoritative permission and all eight roles without human assignments', async () => {
    const permissions = await prisma.permission.findMany();
    expect(permissions.map((row) => row.key).sort()).toEqual(Object.values(PermissionKey).sort());
    expect(await prisma.role.count()).toBe(8);
    expect(await prisma.rolePermission.count()).toBeGreaterThan(0);
    expect(await prisma.staffRole.count()).toBe(0);
  });

  it('populates the exact achievement reference catalog', async () => {
    for (const definition of ACHIEVEMENT_SEED_DATA) {
      expect(
        await prisma.achievementDefinition.findUnique({ where: { code: definition.code } }),
      ).toMatchObject(definition);
    }
    expect(await prisma.achievementDefinition.count()).toBe(5);
  });

  it('preserves all eleven frozen advertising slot policies', async () => {
    expect(await prisma.adSlot.count()).toBe(11);
    for (const slot of HOME_AD_SLOTS) {
      expect(await prisma.adSlot.findUnique({ where: { code: slot.code } })).toMatchObject(slot);
    }
  });

  it('creates no people, privileged staff, buildings or units', async () => {
    expect(await prisma.person.count()).toBe(0);
    expect(await prisma.platformStaff.count()).toBe(0);
    expect(await prisma.staffRole.count()).toBe(0);
    expect(await prisma.building.count()).toBe(0);
    expect(await prisma.unit.count()).toBe(0);
  });

  it('is idempotent including stable IDs, grants and audit counts', async () => {
    run('prisma/seed.ts');
    expect(await snapshot()).toEqual(beforeRerun);
    expect(await prisma.person.count()).toBe(0);
    expect(await prisma.platformStaff.count()).toBe(0);
  }, 120_000);

  it('refuses the separate demo seed in production before any identity write', async () => {
    expect(() => run('prisma/seed/dev.seed.ts')).toThrow();
    expect(await prisma.person.count()).toBe(0);
    expect(await prisma.platformStaff.count()).toBe(0);
  });
});
