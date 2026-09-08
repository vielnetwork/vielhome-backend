// Explicit disposable database only. Build first, then run with node --test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PrismaClient } = require('@prisma/client');
const { readBackupConfig } = require('../dist/src/backup/backup.config');
const { queueMetrics } = require('../dist/src/backup/backup.queue-metrics');
const { BackupRepository } = require('../dist/src/backup/backup.repository');
const { BackupRunner } = require('../dist/src/backup/backup.runner');
const {
  DocumentRepository,
} = require('../dist/src/modules/documents/infrastructure/repositories/document.repository');
const url = new URL(process.env.BACKUP_OPERATIONAL_TEST_DATABASE_URL || 'http://invalid');
assert.equal(url.protocol, 'postgresql:');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.equal(url.pathname, '/vielhome_prod_rel_07i1fr1');
const bucket = 'test-operational';
const config = readBackupConfig(
  { BACKUP_ENV: 'test', BACKUP_DATABASE_URL: url.href, BACKUP_SOURCE_BUCKET: bucket },
  'metrics',
);
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const other = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const ids = [];
const create = async (data = {}) => {
  const row = await db.objectBackupRequest.create({
    data: {
      sourceBucket: bucket,
      sourceKey: randomUUID(),
      referenceType: 'SYNTHETIC',
      referenceId: randomUUID(),
      finalizedAt: new Date(),
      ...data,
    },
  });
  ids.push(row.id);
  return row;
};
const clean = async () => {
  await db.objectBackupGeneration.deleteMany({ where: { requestId: { in: ids } } });
  await db.objectBackupRequest.deleteMany({ where: { id: { in: ids } } });
};

test('real PostgreSQL operational controls', async (t) => {
  try {
    await t.test(
      'every pooled connection receives statement, lock and idle transaction bounds',
      async () => {
        for (const client of [db, other]) {
          assert.equal(
            (await client.$queryRawUnsafe('SHOW statement_timeout'))[0].statement_timeout,
            '10s',
          );
          assert.equal((await client.$queryRawUnsafe('SHOW lock_timeout'))[0].lock_timeout, '3s');
          assert.equal(
            (await client.$queryRawUnsafe('SHOW idle_in_transaction_session_timeout'))[0]
              .idle_in_transaction_session_timeout,
            '15s',
          );
        }
      },
    );
    await t.test(
      'queue coverage includes non-document requests and strict RPO boundaries',
      async () => {
        const now = new Date();
        for (const age of [899, 900, 901])
          await create({ finalizedAt: new Date(now.getTime() - age * 1000) });
        const m = await queueMetrics(db, bucket, now);
        assert.equal(m.pendingCount, 3);
        assert.equal(m.unprotectedCount, 3);
        assert.equal(m.oldestUnprotectedAgeSeconds, 901);
        assert.equal(m.overdueCount, 1);
        await clean();
      },
    );
    await t.test(
      'failed, missing, exhausted and invalid/expired lease counts persist',
      async () => {
        await create({ state: 'FAILED', attempts: 10 });
        await create({ state: 'SOURCE_MISSING' });
        await create({
          state: 'COPYING',
          leaseOwner: 'active',
          leaseUntil: new Date(Date.now() + 60000),
        });
        await create({
          state: 'COPYING',
          leaseOwner: 'expired',
          leaseUntil: new Date(Date.now() - 1000),
        });
        await create({ state: 'COPYING' });
        const m = await queueMetrics(db, bucket);
        assert.equal(m.failedCount, 1);
        assert.equal(m.sourceMissingCount, 1);
        assert.equal(m.exhaustedCount, 1);
        assert.equal(m.activeLeaseCount, 1);
        assert.equal(m.expiredLeaseCount, 1);
        assert.equal(m.invalidLeaseCount, 1);
        await clean();
      },
    );
    await t.test(
      'protection latency uses first verified generation and flags conflicts',
      async () => {
        const final = new Date(Date.now() - 1000000);
        const row = await create({ state: 'VERIFIED', finalizedAt: final });
        const repo = new BackupRepository(db, bucket);
        const g = await repo.createGeneration(row, 'test-backup');
        await db.objectBackupGeneration.update({
          where: { id: g.id },
          data: {
            verifiedAt: new Date(final.getTime() + 901000),
            sha256: 'a'.repeat(64),
            sourceETag: 'synthetic',
            observedSize: 3n,
          },
        });
        let m = await queueMetrics(db, bucket);
        assert.equal(m.maxProtectionLatencySeconds, 901);
        assert.equal(m.lateVerifiedCount, 1);
        assert.equal(m.unprotectedCount, 0);
        const conflicting = await repo.createGeneration(row, 'test-backup');
        await db.objectBackupGeneration.update({
          where: { id: conflicting.id },
          data: {
            verifiedAt: new Date(),
            sha256: 'b'.repeat(64),
            sourceETag: 'synthetic',
            observedSize: 3n,
          },
        });
        m = await queueMetrics(db, bucket);
        assert.equal(m.invalidVerifiedCount, 1);
        assert.equal(m.unprotectedCount, 1);
        await clean();
      },
    );
    await t.test('missing and incomplete verified metadata is unhealthy', async () => {
      await create({ state: 'VERIFIED' });
      const row = await create({ state: 'VERIFIED' });
      const g = await new BackupRepository(db, bucket).createGeneration(row, 'test-backup');
      await db.objectBackupGeneration.update({
        where: { id: g.id },
        data: { verifiedAt: new Date() },
      });
      assert.equal((await queueMetrics(db, bucket)).invalidVerifiedCount, 2);
      await clean();
    });
    await t.test(
      'metrics CLI needs no R2 credentials and exits one for unhealthy queue',
      async () => {
        await create({ state: 'FAILED' });
        try {
          await promisify(execFile)(process.execPath, ['dist/src/backup/main.js', 'metrics'], {
            cwd: require('node:path').resolve(__dirname, '..'),
            env: {
              PATH: process.env.PATH,
              BACKUP_ENV: 'test',
              BACKUP_DATABASE_URL: url.href,
              BACKUP_SOURCE_BUCKET: bucket,
            },
            timeout: 30000,
          });
          assert.fail('expected unhealthy exit');
        } catch (e) {
          assert.equal(e.code, 1);
          const events = e.stdout.trim().split('\n').map(JSON.parse);
          assert.equal(events[0].event, 'backup.started');
          assert.equal(events.at(-1).exitCode, 1);
          assert.equal(events.at(-1).summary.queue.failedCount, 1);
        }
        await clean();
      },
    );
    await t.test(
      'runner verifies synthetic bytes using real DB with fenced generation relation',
      async () => {
        const row = await create({ expectedSize: 3n });
        const objects = new Map();
        const storage = {
          headSource: async () => ({ size: 3, etag: 'e', lastModified: 'synthetic' }),
          readSource: async () => Buffer.from('abc'),
          putNew: async (k, b) => {
            assert(!objects.has(k));
            objects.set(k, b);
          },
          readBackup: async (k) => objects.get(k),
        };
        const repo = new BackupRepository(db, bucket);
        assert.equal(
          await new BackupRunner(repo, storage, 'test-backup', 'test').runOne(),
          'verified',
        );
        assert.equal(
          (await db.objectBackupRequest.findUnique({ where: { id: row.id } })).state,
          'VERIFIED',
        );
        await clean();
        await create();
        const claimed = await repo.claim();
        await assert.rejects(
          repo.verify(
            claimed,
            { id: randomUUID() },
            {
              sourceETag: 'e',
              sourceLastModified: 'synthetic',
              observedSize: 3n,
              sha256: 'a'.repeat(64),
              verifiedAt: new Date(),
            },
          ),
          /GENERATION_MISMATCH/,
        );
        assert.equal(
          (await db.objectBackupRequest.findUnique({ where: { id: claimed.id } })).state,
          'COPYING',
        );
        await clean();
      },
    );
    await t.test('database lock contention is bounded', async () => {
      const row = await create();
      let ready;
      const acquired = new Promise((r) => (ready = r));
      let release;
      const done = new Promise((r) => (release = r));
      const holder = db.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE object_backup_requests SET attempts=attempts WHERE id=${row.id}`;
          ready();
          await done;
        },
        { timeout: 15000 },
      );
      await acquired;
      const start = Date.now();
      try {
        await assert.rejects(
          other.objectBackupRequest.update({ where: { id: row.id }, data: { attempts: 1 } }),
        );
        assert(Date.now() - start < 8000);
      } finally {
        release();
        await holder;
        await clean();
      }
    });
    await t.test(
      'document finalization still creates request atomically; closed gate writes nothing',
      async () => {
        const old = process.env.VH_IMPORTANT_UPLOADS_BLOCKED,
          oldBucket = process.env.STORAGE_BUCKET;
        const person = await db.person.create({ data: { phone: 'synthetic-' + randomUUID() } });
        const building = await db.building.create({
          data: {
            name: 'synthetic',
            country: 'test',
            city: 'test',
            district: 'test',
            mainStreet: 'test',
            plateNumber: 'test',
            addressLine: 'test',
            postalCode: randomUUID(),
            createdById: person.id,
          },
        });
        const params = {
          buildingId: building.id,
          createdById: person.id,
          category: 'FINANCIAL',
          title: 'synthetic',
          visibility: 'MEMBERS_ONLY',
          fileUrl: 'synthetic/' + randomUUID(),
          fileName: 'synthetic',
          fileType: 'pdf',
          fileSize: 3,
        };
        const docs = new DocumentRepository(db);
        let document;
        try {
          process.env.STORAGE_BUCKET = bucket;
          process.env.VH_IMPORTANT_UPLOADS_BLOCKED = 'false';
          document = await docs.createDocumentWithFirstVersion(params);
          const request = await db.objectBackupRequest.findFirstOrThrow({
            where: { referenceId: document.version.id },
          });
          ids.push(request.id);
          process.env.VH_IMPORTANT_UPLOADS_BLOCKED = 'true';
          await assert.rejects(
            docs.createDocumentWithFirstVersion(params),
            (e) => e.httpStatus === 503,
          );
          assert.equal(await db.document.count({ where: { buildingId: building.id } }), 1);
        } finally {
          if (old === undefined) delete process.env.VH_IMPORTANT_UPLOADS_BLOCKED;
          else process.env.VH_IMPORTANT_UPLOADS_BLOCKED = old;
          if (oldBucket === undefined) delete process.env.STORAGE_BUCKET;
          else process.env.STORAGE_BUCKET = oldBucket;
          await clean();
          if (document) {
            await db.documentVersion.deleteMany({ where: { documentId: document.document.id } });
            await db.document.delete({ where: { id: document.document.id } });
          }
          await db.building.delete({ where: { id: building.id } });
          await db.person.delete({ where: { id: person.id } });
        }
      },
    );
  } finally {
    await clean();
    await db.$disconnect();
    await other.$disconnect();
  }
});
