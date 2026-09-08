// Run with node --test; requires a fresh database built from migration history.
// Never falls back to the application's DATABASE_URL or loads dotenv.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.FRAUD_EVIDENCE_TEST_DATABASE_URL || 'http://invalid');
assert.equal(url.protocol, 'postgresql:');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.equal(url.pathname, '/vielhome_prod_rel_07i1e_d2');
const db = new PrismaClient({ datasources: { db: { url: url.href } } });

test('migration-built fraud evidence preserves nullable authors and restricts deletion', async (t) => {
  const caseId = randomUUID();
  const authorId = randomUUID();
  try {
    const migrations = await db.$queryRaw`
      SELECT migration_name FROM _prisma_migrations
      WHERE migration_name = '20260807161000_backfill_legacy_fraud_evidence'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    assert.equal(migrations.length, 1);
    await db.person.create({ data: { id: authorId, phone: `synthetic-${authorId}` } });
    await db.fraudCase.create({ data: { id: caseId, source: 'USER_REPORT' } });
    await t.test('legacy evidence accepts a NULL author', async () => {
      const evidence = await db.fraudCaseEvidence.create({
        data: { fraudCaseId: caseId, notes: 'legacy synthetic evidence', authorId: null },
        include: { author: true },
      });
      assert.equal(evidence.authorId, null);
      assert.equal(evidence.author, null);
    });
    const known = await db.fraudCaseEvidence.create({
      data: { fraudCaseId: caseId, notes: 'attributed synthetic evidence', authorId },
      include: { author: true },
    });
    await t.test('known author relation is preserved', async () => {
      assert.equal(known.authorId, authorId);
      assert.equal(known.author.id, authorId);
    });
    await t.test('real foreign key rejects author deletion without losing evidence', async () => {
      await assert.rejects(db.person.delete({ where: { id: authorId } }), { code: 'P2003' });
      const retained = await db.fraudCaseEvidence.findUniqueOrThrow({ where: { id: known.id } });
      assert.equal(retained.authorId, authorId);
      assert.equal(retained.notes, known.notes);
      assert(await db.person.findUnique({ where: { id: authorId } }));
      const constraints = await db.$queryRaw`
        SELECT confdeltype FROM pg_constraint
        WHERE conname = 'fraud_case_evidence_authorId_fkey'`;
      assert.equal(constraints[0].confdeltype, 'r');
    });
  } finally {
    await db.fraudCaseEvidence.deleteMany({ where: { fraudCaseId: caseId } });
    await db.fraudCase.deleteMany({ where: { id: caseId } });
    await db.person.deleteMany({ where: { id: authorId } });
    await db.$disconnect();
  }
});
