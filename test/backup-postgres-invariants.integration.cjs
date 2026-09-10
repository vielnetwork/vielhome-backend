// Explicit disposable PostgreSQL only; never loads dotenv or application DATABASE_URL.
// Build first. Run serially with: node --test test/backup-postgres-invariants.integration.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { BackupRepository } = require('../dist/src/backup/backup.repository');
const {
  DocumentRepository,
} = require('../dist/src/modules/documents/infrastructure/repositories/document.repository');
const url = new URL(process.env.BACKUP_INVARIANTS_TEST_DATABASE_URL || 'http://invalid');
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, '127.0.0.1');
assert.match(url.pathname, /^\/vh_r3_a2s4_[a-z0-9_]+$/);
assert.equal(url.username, 'vh_disposable');
url.search = 'connection_limit=1&connect_timeout=5&socket_timeout=20';
const client = () => new PrismaClient({ datasources: { db: { url: url.href } } });
const metadata = {
  sourceETag: 'synthetic',
  sourceLastModified: 'synthetic',
  observedSize: 3n,
  sha256: 'a'.repeat(64),
  verifiedAt: new Date(),
};
async function fixture(fn) {
  const db = client(),
    a = client(),
    b = client();
  const bucket = 'synthetic-' + randomUUID();
  try {
    assert.match((await db.$queryRawUnsafe('SHOW server_version'))[0].server_version, /^16\./);
    const pids = await Promise.all(
      [a, b].map(async (c) => (await c.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid),
    );
    assert.notEqual(pids[0], pids[1]);
    const create = (data = {}) =>
      db.objectBackupRequest.create({
        data: {
          sourceBucket: bucket,
          sourceKey: randomUUID(),
          referenceType: 'SYNTHETIC',
          referenceId: randomUUID(),
          finalizedAt: new Date(0),
          nextAttemptAt: new Date(0),
          ...data,
        },
      });
    await fn({
      db,
      a,
      b,
      bucket,
      pids,
      create,
      ra: new BackupRepository(a, bucket),
      rb: new BackupRepository(b, bucket),
    });
  } finally {
    try {
      await db.objectBackupGeneration.deleteMany({ where: { request: { sourceBucket: bucket } } });
      await db.objectBackupRequest.deleteMany({ where: { sourceBucket: bucket } });
    } finally {
      await Promise.all([db, a, b].map((c) => c.$disconnect()));
    }
  }
}
// Hold the row until BOTH independent sessions demonstrably wait on a PostgreSQL
// lock. Polling observes a condition, not a guessed sleep determining the winner.
async function race(c, row, operations) {
  let release, locked;
  const ready = new Promise((r) => {
    locked = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const holder = c.db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM object_backup_requests WHERE id=${row.id} FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 15000 },
  );
  await Promise.race([ready, holder]);
  const observer = client();
  const pending = operations.map((f) => Promise.resolve().then(f));
  const result = Promise.allSettled(pending);
  try {
    const end = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < end) {
      const rows =
        await observer.$queryRaw`SELECT pid FROM pg_stat_activity WHERE pid IN (${c.pids[0]},${c.pids[1]}) AND wait_event_type='Lock'`;
      if (rows.length === 2) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(blocked, 'both sessions must contend on the locked row');
    console.log(JSON.stringify({ evidence: 'two_lock_waiters', pids: c.pids }));
  } finally {
    release();
    await holder;
    await observer.$disconnect();
  }
  return result;
}

test(
  'A/A2: database rejects duplicate business request and each generation identity',
  { timeout: 30000 },
  () =>
    fixture(async (c) => {
      const r = await c.create();
      await assert.rejects(c.create({ referenceId: r.referenceId }), (e) => e.code === 'P2002');
      const g = await c.ra.createGeneration(r, 'synthetic-backup');
      for (const field of ['captureId', 'backupKey', 'manifestKey']) {
        await assert.rejects(
          c.db.objectBackupGeneration.create({
            data: {
              requestId: r.id,
              captureId: randomUUID(),
              backupBucket: 'synthetic-backup',
              backupKey: randomUUID(),
              manifestKey: randomUUID(),
              [field]: g[field],
            },
          }),
          (e) => e.code === 'P2002',
        );
      }
      assert.equal(await c.db.objectBackupRequest.count({ where: { sourceBucket: c.bucket } }), 1);
      assert.equal(await c.db.objectBackupGeneration.count({ where: { requestId: r.id } }), 1);
    }),
);

test('B: two blocked PostgreSQL sessions compete; one claim owner wins', { timeout: 30000 }, () =>
  fixture(async (c) => {
    const row = await c.create();
    const results = await race(c, row, [() => c.ra.claim(), () => c.rb.claim()]);
    assert(results.every((r) => r.status === 'fulfilled'));
    const claims = results.map((r) => r.value);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.filter((x) => x === null).length, 1);
    const persisted = await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(persisted.leaseOwner, claims.find(Boolean).leaseOwner);
    assert.equal(persisted.attempts, 1);
    console.log(
      JSON.stringify({
        evidence: 'claim_results',
        winnerSession: c.pids[claims.findIndex(Boolean)],
        loserReturnedNull: true,
      }),
    );
  }),
);

test(
  'C/D/E: active lease protected; expired lease reclaimed; stale owner cannot verify',
  { timeout: 30000 },
  () =>
    fixture(async (c) => {
      const row = await c.create();
      const first = await c.ra.claim();
      const generation = await c.ra.createGeneration(first, 'synthetic-backup');
      assert.equal(await c.rb.claim(), null);
      assert.equal(
        (await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: row.id } })).leaseOwner,
        first.leaseOwner,
      );
      await c.db.objectBackupRequest.update({
        where: { id: row.id },
        data: { leaseUntil: new Date(0) },
      });
      const second = await c.rb.claim();
      assert.notEqual(second.leaseOwner, first.leaseOwner);
      assert.equal(second.attempts, 2);
      await assert.rejects(c.ra.verify(first, generation, metadata), /LEASE_LOST/);
      assert.equal(
        (await c.db.objectBackupGeneration.findUniqueOrThrow({ where: { id: generation.id } }))
          .verifiedAt,
        null,
      );
      assert.equal(
        (await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: row.id } })).leaseOwner,
        second.leaseOwner,
      );
      await c.rb.verify(second, generation, metadata);
      assert.equal(
        (await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: row.id } })).state,
        'VERIFIED',
      );
      console.log(JSON.stringify({ evidence: 'stale_owner_fenced', pids: c.pids }));
    }),
);

test('F: concurrent verification commits exactly once', { timeout: 30000 }, () =>
  fixture(async (c) => {
    await c.create();
    const claim = await c.ra.claim();
    const g = await c.ra.createGeneration(claim, 'synthetic-backup');
    const results = await race(c, claim, [
      () => c.ra.verify(claim, g, metadata),
      () => c.rb.verify(claim, g, { ...metadata, sha256: 'b'.repeat(64) }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /LEASE_LOST/);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    const persisted = await c.db.objectBackupGeneration.findUniqueOrThrow({ where: { id: g.id } });
    assert.equal(persisted.sha256, (winner === 0 ? 'a' : 'b').repeat(64));
    assert.equal(
      await c.db.objectBackupGeneration.count({
        where: { requestId: claim.id, verifiedAt: { not: null } },
      }),
      1,
    );
    const request = await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: claim.id } });
    assert.equal(request.state, 'VERIFIED');
    assert.equal(request.leaseOwner, null);
    console.log(
      JSON.stringify({
        evidence: 'verification_results',
        winnerSession: c.pids[winner],
        loser: 'LEASE_LOST',
      }),
    );
  }),
);

test(
  'G: SQL failure rolls back claim; failed generation completion restores lease/state',
  { timeout: 30000 },
  () =>
    fixture(async (c) => {
      const before = await c.create();
      await assert.rejects(
        c.a.$transaction(async (tx) => {
          assert(await new BackupRepository(tx, c.bucket).claim());
          await tx.$queryRawUnsafe('SELECT 1/0');
        }),
        /division by zero/,
      );
      assert.deepEqual(
        await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: before.id } }),
        before,
      );
      const claim = await c.ra.claim();
      await assert.rejects(
        c.ra.verify(claim, { id: randomUUID() }, metadata),
        /GENERATION_MISMATCH/,
      );
      assert.deepEqual(
        await c.db.objectBackupRequest.findUniqueOrThrow({ where: { id: before.id } }),
        claim,
      );
    }),
);

async function business(c, fn) {
  const oldBucket = process.env.STORAGE_BUCKET,
    oldGate = process.env.VH_IMPORTANT_UPLOADS_BLOCKED;
  process.env.STORAGE_BUCKET = c.bucket;
  process.env.VH_IMPORTANT_UPLOADS_BLOCKED = 'false';
  let person, building;
  try {
    person = await c.db.person.create({ data: { phone: 'synthetic-' + randomUUID() } });
    building = await c.db.building.create({
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
    const unit = await c.db.unit.create({ data: { buildingId: building.id, unitNumber: '1' } });
    const fund = await c.db.fund.create({
      data: { buildingId: building.id, name: 'synthetic', isDefault: true },
    });
    const payment = await c.db.payment.create({
      data: {
        buildingId: building.id,
        unitId: unit.id,
        fundId: fund.id,
        payerId: person.id,
        amount: 100,
        method: 'BANK_TRANSFER',
      },
    });
    const key = 'synthetic/' + randomUUID();
    const intent = await c.db.documentUploadIntent.create({
      data: {
        buildingId: building.id,
        requestedById: person.id,
        purpose: 'PAYMENT_RECEIPT',
        paymentId: payment.id,
        storageKey: key,
        fileName: 'synthetic.pdf',
        fileType: 'PDF',
        fileSize: 3,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const params = {
      buildingId: building.id,
      createdById: person.id,
      paymentId: payment.id,
      uploadIntentId: intent.id,
      fileUrl: key,
      fileName: 'synthetic.pdf',
      fileType: 'PDF',
      fileSize: 3,
      category: 'FINANCIAL',
      title: 'synthetic',
      visibility: 'MEMBERS_ONLY',
    };
    await fn({ ...c, params, intent, docs: new DocumentRepository(c.a) });
  } finally {
    if (oldBucket === undefined) delete process.env.STORAGE_BUCKET;
    else process.env.STORAGE_BUCKET = oldBucket;
    if (oldGate === undefined) delete process.env.VH_IMPORTANT_UPLOADS_BLOCKED;
    else process.env.VH_IMPORTANT_UPLOADS_BLOCKED = oldGate;
    await c.db.objectBackupGeneration.deleteMany({
      where: { request: { sourceBucket: c.bucket } },
    });
    await c.db.objectBackupRequest.deleteMany({ where: { sourceBucket: c.bucket } });
    if (building) {
      const where = { buildingId: building.id };
      await c.db.documentReference.deleteMany({ where: { documentVersion: { document: where } } });
      await c.db.documentVersion.deleteMany({ where: { document: where } });
      await c.db.document.deleteMany({ where });
      await c.db.documentUploadIntent.deleteMany({ where });
      await c.db.payment.deleteMany({ where });
      await c.db.unit.deleteMany({ where });
      await c.db.fund.deleteMany({ where });
      await c.db.building.delete({ where: { id: building.id } });
    }
    if (person) await c.db.person.delete({ where: { id: person.id } });
  }
}
// Test-only PostgreSQL trigger fires AFTER backup insertion. A nontransactional
// sequence proves the injected failure was reached after business/backup writes.
async function injectedFailure(c, operation, receipt) {
  try {
    await c.db.$executeRawUnsafe('CREATE SEQUENCE test_backup_failure_witness');
    await c.db
      .$executeRawUnsafe(`CREATE FUNCTION test_backup_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM document_versions WHERE id=NEW."referenceId") THEN RAISE EXCEPTION 'MISSING_VERSION'; END IF;
    ${receipt ? `IF NOT EXISTS (SELECT 1 FROM document_references WHERE "documentVersionId"=NEW."referenceId" AND "entityType"='PAYMENT') THEN RAISE EXCEPTION 'MISSING_RECEIPT_REFERENCE'; END IF;` : ''}
    PERFORM nextval('test_backup_failure_witness'); RAISE EXCEPTION 'S4_INJECTED_DB_FAILURE'; END $$`);
    await c.db.$executeRawUnsafe(
      'CREATE TRIGGER test_backup_abort AFTER INSERT ON object_backup_requests FOR EACH ROW EXECUTE FUNCTION test_backup_abort()',
    );
    await assert.rejects(operation(), /S4_INJECTED_DB_FAILURE/);
    const witness = await c.db.$queryRawUnsafe('SELECT is_called FROM test_backup_failure_witness');
    assert.equal(witness[0].is_called, true);
    assert.equal(await c.db.document.count({ where: { buildingId: c.params.buildingId } }), 0);
    assert.equal(await c.db.documentVersion.count({ where: { fileUrl: c.params.fileUrl } }), 0);
    assert.equal(
      await c.db.documentReference.count({ where: { entityId: c.params.paymentId } }),
      0,
    );
    assert.equal(await c.db.objectBackupRequest.count({ where: { sourceBucket: c.bucket } }), 0);
    assert.equal(
      (await c.db.documentUploadIntent.findUniqueOrThrow({ where: { id: c.intent.id } }))
        .consumedAt,
      null,
    );
  } finally {
    await c.db.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS test_backup_abort ON object_backup_requests',
    );
    await c.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_backup_abort()');
    await c.db.$executeRawUnsafe('DROP SEQUENCE IF EXISTS test_backup_failure_witness');
  }
}

test(
  'I: document finalization DB failure rolls back intent, document, version and backup',
  { timeout: 30000 },
  () =>
    fixture((c) =>
      business(c, (x) =>
        injectedFailure(x, () => x.docs.createDocumentWithFirstVersion(x.params), false),
      ),
    ),
);
test(
  'J: receipt finalization commits intent, reference, document/version and backup together',
  { timeout: 30000 },
  () =>
    fixture((c) =>
      business(c, async (x) => {
        const { document, version } = await x.docs.createPaymentReceipt(x.params);
        const request = await x.db.objectBackupRequest.findFirstOrThrow({
          where: { sourceBucket: x.bucket, referenceId: version.id },
        });
        assert.equal(request.sourceKey, x.params.fileUrl);
        assert.equal(request.expectedSize, 3n);
        assert.equal(request.referenceType, 'DOCUMENT_VERSION');
        assert.equal(
          (await x.db.documentVersion.findUniqueOrThrow({ where: { id: version.id } })).documentId,
          document.id,
        );
        assert.equal(
          await x.db.documentReference.count({
            where: {
              documentVersionId: version.id,
              entityId: x.params.paymentId,
              entityType: 'PAYMENT',
            },
          }),
          1,
        );
        assert.notEqual(
          (await x.db.documentUploadIntent.findUniqueOrThrow({ where: { id: x.intent.id } }))
            .consumedAt,
          null,
        );
      }),
    ),
);
test(
  'K: receipt DB failure rolls back intent, receipt reference, document/version and backup',
  { timeout: 30000 },
  () =>
    fixture((c) =>
      business(c, (x) => injectedFailure(x, () => x.docs.createPaymentReceipt(x.params), true)),
    ),
);
