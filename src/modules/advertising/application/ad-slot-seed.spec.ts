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

  it('keeps every slot direct-only by default and enables QA fallback only for HOM-N-06', () => {
    expect(fillMigration).toContain(`DEFAULT 'DIRECT_ONLY'`);
    expect(fillMigration).toContain(`DEFAULT 'NONE'`);
    expect(fillMigration).toContain(`WHERE "code" = 'HOM-N-06'`);
    expect(fillMigration).toContain('ca-app-pub-3940256099942544/2247696110');
    expect(fillMigration).toContain('ca-app-pub-3940256099942544/3986624511');
    expect(seed).toContain('index === 5');
  });
});
