import { PrismaClient } from '@prisma/client';
import { readBackupConfig } from './backup.config';
import { HttpBackupStorage } from './backup.storage';
import { BackupRepository } from './backup.repository';
import { BackupRunner } from './backup.runner';
import { backupMetrics, reconcile } from './backup.reconciliation';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const mode = args[0] ?? 'run';
  if (!['run', 'reconcile', 'metrics'].includes(mode)) throw new Error('INVALID_BACKUP_COMMAND');
  const c = readBackupConfig(process.env);
  // Explicit datasource; never implicitly use application DATABASE_URL or dotenv.
  const db = new PrismaClient({ datasources: { db: { url: c.databaseUrl } }, log: [] });
  try {
    const storage = new HttpBackupStorage(c.source, c.destination, c.maxBytes);
    if (mode === 'metrics') {
      console.log(JSON.stringify(await backupMetrics(db, c.source.bucket)));
      return;
    }
    if (mode === 'reconcile') {
      console.log(JSON.stringify(await reconcile(db, c.source.bucket, storage)));
      return;
    }
    const runner = new BackupRunner(
      new BackupRepository(db, c.source.bucket),
      storage,
      c.destination.bucket,
      c.environment,
    );
    let verified = 0,
      failed = 0;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && verified + failed < 100) {
      const outcome = await runner.runOne();
      if (outcome === 'idle') break;
      if (outcome === 'verified') verified++;
      else failed++;
    }
    console.log(JSON.stringify({ verified, failed }));
    if (failed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error('BACKUP_COMMAND_FAILED');
    process.exitCode = 1;
  });
