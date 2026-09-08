import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { readBackupConfig, BackupMode } from './backup.config';
import { HttpBackupStorage } from './backup.storage';
import { ExecutionControl, installTermination } from './backup.execution';
import { operate } from './backup.operations';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const mode = args[0] ?? 'run';
  const runId = randomUUID();
  const started = Date.now();
  const emit = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        event,
        mode: ['run', 'metrics', 'reconcile'].includes(mode) ? mode : 'invalid',
        runId,
        timestamp: new Date().toISOString(),
        ...fields,
      }),
    );
  emit('backup.started');
  const control = new ExecutionControl();
  const dispose = installTermination(control, () => {
    emit('backup.terminated', { exitCode: 2 });
    process.exit(2);
  });
  let db: PrismaClient | undefined;
  let exitCode = 2;
  let summary: unknown;
  try {
    if (!['run', 'metrics', 'reconcile'].includes(mode) || args.length > 1)
      throw new Error('INVALID_MODE');
    const c = readBackupConfig(process.env, mode as BackupMode);
    db = new PrismaClient({ datasources: { db: { url: c.databaseUrl } }, log: [] });
    const storage =
      c.mode === 'metrics'
        ? undefined
        : new HttpBackupStorage(c.source, c.mode === 'run' ? c.destination : undefined, c.maxBytes);
    const result = await operate(c, db, control, storage);
    exitCode = control.stopping ? 2 : result.exitCode;
    summary = result.summary;
  } catch {
    exitCode = 2;
  } finally {
    try {
      await db?.$disconnect();
    } catch {
      exitCode = 2;
    }
    dispose();
    emit('backup.completed', {
      outcome: exitCode === 0 ? 'healthy' : 'unhealthy',
      exitCode,
      durationMs: Date.now() - started,
      ...(summary ? { summary } : {}),
    });
    process.exitCode = exitCode;
  }
}
if (require.main === module) void main();
