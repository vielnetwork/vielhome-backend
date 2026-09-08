import { operate, operationallyUnhealthy } from './backup.operations';
import { queueMetrics } from './backup.queue-metrics';
import { backupMetrics, reconcile } from './backup.reconciliation';
import { ExecutionControl, installTermination } from './backup.execution';
import { BackupRepository } from './backup.repository';
jest.mock('./backup.queue-metrics');
jest.mock('./backup.reconciliation');
const healthy = {
  oldestUnprotectedAgeSeconds: 0,
  failedCount: 0,
  sourceMissingCount: 0,
  exhaustedCount: 0,
  expiredLeaseCount: 0,
  invalidLeaseCount: 0,
  invalidVerifiedCount: 0,
  overdueCount: 0,
};
const config: any = { mode: 'metrics', sourceBucket: 'test-primary' };
describe('operational status', () => {
  beforeEach(() => {
    jest.mocked(queueMetrics).mockResolvedValue(healthy as any);
    jest.mocked(backupMetrics).mockResolvedValue({
      unprotectedCount: 0,
      oldestUnprotectedAgeSeconds: 0,
      failedCount: 0,
      overdueCount: 0,
    });
  });
  it('healthy metrics exit zero', async () => {
    expect((await operate(config, {} as any, new ExecutionControl())).exitCode).toBe(0);
  });
  it.each([
    'failedCount',
    'sourceMissingCount',
    'exhaustedCount',
    'expiredLeaseCount',
    'invalidLeaseCount',
    'invalidVerifiedCount',
    'overdueCount',
  ])('%s is unhealthy', async (key) => {
    jest.mocked(queueMetrics).mockResolvedValue({ ...healthy, [key]: 1 } as any);
    expect((await operate(config, {} as any, new ExecutionControl())).exitCode).toBe(1);
  });
  it('uses a strict fifteen-minute age boundary', () => {
    expect(operationallyUnhealthy({ ...healthy, oldestUnprotectedAgeSeconds: 900 } as any)).toBe(
      false,
    );
    expect(operationallyUnhealthy({ ...healthy, oldestUnprotectedAgeSeconds: 901 } as any)).toBe(
      true,
    );
  });
  it('does not convert metrics failure to healthy zero', async () => {
    jest.mocked(queueMetrics).mockRejectedValue(new Error('database failure'));
    await expect(operate(config, {} as any, new ExecutionControl())).rejects.toThrow();
  });
  it.each([0, 1])('reconciliation discrepancy count %s controls exit', async (count) => {
    jest.mocked(reconcile).mockResolvedValue({
      missingRequests: count,
      overdueRequests: 0,
      invalidVerifiedMetadata: 0,
      missingSources: 0,
      sourceCheckFailures: 0,
      conflictingGenerations: 0,
    });
    expect(
      (
        await operate(
          { mode: 'reconcile', source: { bucket: 'test-primary' } } as any,
          {} as any,
          new ExecutionControl(),
          {} as any,
        )
      ).exitCode,
    ).toBe(count);
  });
  it.each([0, 1])('idle processing reports exhausted queue count %s', async (count) => {
    jest.mocked(queueMetrics).mockResolvedValue({ ...healthy, exhaustedCount: count } as any);
    const db: any = { objectBackupRequest: { findMany: jest.fn().mockResolvedValue([]) } };
    expect(
      (
        await operate(
          {
            mode: 'run',
            source: { bucket: 'test-primary' },
            destination: { bucket: 'test-backup' },
          } as any,
          db,
          new ExecutionControl(),
          {} as any,
        )
      ).exitCode,
    ).toBe(count);
  });
});
describe('one-shot termination', () => {
  it('stops claiming at the deadline', () => {
    let now = 0;
    const c = new ExecutionControl(() => now);
    expect(c.canClaim()).toBe(true);
    now = 240000;
    expect(c.canClaim()).toBe(false);
  });
  it('checks termination again after candidate lookup', async () => {
    const c = new ExecutionControl();
    const db: any = {
      objectBackupRequest: {
        findMany: async () => {
          c.stop();
          return [{ id: 'r' }];
        },
        updateMany: jest.fn(),
      },
    };
    expect(await new BackupRepository(db, 'test-primary', c.canClaim).claim()).toBeNull();
    expect(db.objectBackupRequest.updateMany).not.toHaveBeenCalled();
  });
  it('SIGTERM stops new claims, then enforces a bounded grace interval', () => {
    jest.useFakeTimers();
    const c = new ExecutionControl();
    const force = jest.fn();
    const dispose = installTermination(c, force);
    try {
      process.emit('SIGTERM');
      expect(c.canClaim()).toBe(false);
      expect(force).not.toHaveBeenCalled();
      jest.advanceTimersByTime(30000);
      expect(force).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      jest.useRealTimers();
    }
  });
});
