import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('advertising slot registry seed and migration', () => {
  const seed = readFileSync(join(process.cwd(), 'prisma/seed/ad-slots.seed.ts'), 'utf8');
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260822190000_add_advertising_slot_registry/migration.sql',
    ),
    'utf8',
  );
  const fillMigration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260822220000_add_hom_n06_admob_fallback/migration.sql',
    ),
    'utf8',
  );
  const correctiveMigration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260903120000_align_home_ad_slot_fallback_policy/migration.sql',
    ),
    'utf8',
  );

  it('defines all nine immutable Home codes exactly once in the migration', () => {
    for (const zone of ['N', 'S']) {
      const count = zone === 'N' ? 6 : 3;
      for (let position = 1; position <= count; position += 1) {
        const code = `HOM-${zone}-0${position}`;
        expect(migration.match(new RegExp(`'${code}'`, 'g'))).toHaveLength(1);
      }
    }
  });

  it('uses code-keyed upserts and never deletes slots', () => {
    expect(seed).toContain('prisma.adSlot.upsert');
    expect(seed).toContain('where: { code: slot.code }');
    expect(seed).not.toMatch(/adSlot\.(delete|deleteMany)/);
  });

  it('backfills the two supported legacy Home placements deterministically', () => {
    expect(migration).toContain(`"placement" = 'HOME_TODAY_OFFERS'`);
    expect(migration).toContain(`"adSlotId" = 'slot-home-n-01'`);
    expect(migration).toContain(`"placement" = 'HOME_FEATURED_LARGE'`);
    expect(migration).toContain(`"adSlotId" = 'slot-home-s-01'`);
  });

  it('preserves the historical N6 migration and corrects deployed N/S policy additively', () => {
    expect(fillMigration).toContain(`DEFAULT 'DIRECT_ONLY'`);
    expect(fillMigration).toContain(`DEFAULT 'NONE'`);
    expect(fillMigration).toContain(`WHERE "code" = 'HOM-N-06'`);
    for (let position = 1; position <= 6; position += 1) {
      expect(correctiveMigration).toContain(`'HOM-N-0${position}'`);
    }
    for (let position = 1; position <= 3; position += 1) {
      expect(correctiveMigration).toContain(`'HOM-S-0${position}'`);
    }
    expect(correctiveMigration).toContain(`"fillStrategy" = 'DIRECT_ONLY'`);
    expect(correctiveMigration).toContain(`"externalProvider" = 'NONE'`);
    expect(correctiveMigration).toContain(`"fillStrategy" = 'DIRECT_THEN_EXTERNAL'`);
    expect(correctiveMigration).toContain(`"externalProvider" = 'ADMOB'`);
    expect(correctiveMigration.match(/"androidAdUnitId" = NULL/g)).toHaveLength(2);
    expect(correctiveMigration.match(/"iosAdUnitId" = NULL/g)).toHaveLength(2);
    expect(correctiveMigration).not.toContain('ca-app-pub-');
    expect(seed).not.toContain('index === 5');
    expect(seed).not.toContain('ca-app-pub-');
  });
});
