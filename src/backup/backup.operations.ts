import { PrismaClient } from '@prisma/client';
import { BackupConfig, MetricsConfig, ReconcileConfig } from './backup.config';
import { BackupStorage } from './backup.storage';
import { BackupRunner } from './backup.runner';
import { BackupRepository } from './backup.repository';
import { backupMetrics, reconcile } from './backup.reconciliation';
import { queueMetrics } from './backup.queue-metrics';
import { ExecutionControl } from './backup.execution';

export function operationallyUnhealthy(metrics: Awaited<ReturnType<typeof queueMetrics>>): boolean {
  return (
    metrics.oldestUnprotectedAgeSeconds > 900 ||
    [
      'failedCount',
      'sourceMissingCount',
      'exhaustedCount',
      'expiredLeaseCount',
      'invalidLeaseCount',
      'invalidVerifiedCount',
      'overdueCount',
    ].some((key) => (metrics[key as keyof typeof metrics] as number) > 0)
  );
}
export async function operate(
  c: BackupConfig | MetricsConfig | ReconcileConfig,
  db: PrismaClient,
  control: ExecutionControl,
  storage?: BackupStorage,
) {
  if (c.mode === 'metrics') {
    const queue = await queueMetrics(db, c.sourceBucket);
    const documents = await backupMetrics(db, c.sourceBucket);
    const unhealthy =
      operationallyUnhealthy(queue) ||
      documents.overdueCount > 0 ||
      documents.failedCount > 0 ||
      documents.oldestUnprotectedAgeSeconds > 900;
    return { exitCode: unhealthy ? 1 : 0, summary: { queue, documents } };
  }
  if (!storage) throw new Error('STORAGE_UNAVAILABLE');
  if (c.mode === 'reconcile') {
    const report = await reconcile(db, c.source.bucket, storage, () => !control.stopping);
    return { exitCode: Object.values(report).some((n) => n > 0) ? 1 : 0, summary: report };
  }
  const runner = new BackupRunner(
    new BackupRepository(db, c.source.bucket, control.canClaim),
    storage,
    c.destination.bucket,
    c.environment,
  );
  let verified = 0,
    failed = 0;
  while (control.canClaim() && verified + failed < 100) {
    const outcome = await runner.runOne();
    if (outcome === 'idle') break;
    if (outcome === 'verified') verified++;
    else failed++;
  }
  const queue = await queueMetrics(db, c.source.bucket);
  return {
    exitCode: failed || operationallyUnhealthy(queue) ? 1 : 0,
    summary: { verified, failed, queue },
  };
}
